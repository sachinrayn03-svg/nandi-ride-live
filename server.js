const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite Database Setup
const db = new sqlite3.Database('./rides.db', (err) => {
  if (err) console.error('DB Error:', err.message);
  else console.log('SQLite Database Connected for Nandi Ride.');
});

// Create Tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS rides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rider_phone TEXT,
    driver_phone TEXT,
    fare REAL,
    distance REAL,
    vehicle_type TEXT,
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT,
    name TEXT,
    phone TEXT UNIQUE,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Authentication APIs
app.post('/api/auth/signup', (req, res) => {
  const { role, name, phone, password } = req.body;
  if (!role || !name || !phone || !password) {
    return res.status(400).json({ error: 'Kripya saari details bharein.' });
  }

  const query = `INSERT INTO accounts (role, name, phone, password) VALUES (?, ?, ?, ?)`;
  db.run(query, [role, name, phone, password], function (err) {
    if (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(400).json({ error: 'Yeh phone number pehle se registered hai.' });
      }
      return res.status(500).json({ error: err.message });
    }
    res.json({ success: true, message: 'Account ban gaya!', user: { id: this.lastID, role, name, phone } });
  });
});

app.post('/api/auth/login', (req, res) => {
  const { role, phone, password } = req.body;
  db.get(
    `SELECT id, role, name, phone FROM accounts WHERE role = ? AND phone = ? AND password = ?`,
    [role, phone, password],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(401).json({ error: 'Galat phone number ya password.' });
      res.json({ success: true, user: row });
    }
  );
});

// Trip History API
app.get('/api/history', (req, res) => {
  db.all('SELECT * FROM rides ORDER BY id DESC LIMIT 10', [], (err, rows) => {
    if (err) res.status(500).json({ error: err.message });
    else res.json(rows);
  });
});

// Socket.io Real-time Ride Engine
let rides = {};

io.on('connection', (socket) => {
  // Driver Status & Live Location
  socket.on('driver-online', (data) => {
    socket.broadcast.emit('driver-available', { driverId: socket.id, ...data });
  });

  socket.on('update-driver-location', (data) => {
    io.emit('driver-location-updated', {
      driverId: socket.id,
      lat: data.lat,
      lng: data.lng
    });
  });

  // Rider Booking Request
  socket.on('request-ride', (data) => {
    const rideId = 'NANDI_' + Date.now();
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    rides[rideId] = {
      rideId,
      riderSocketId: socket.id,
      riderPhone: data.riderPhone || 'Guest',
      driverSocketId: null,
      fare: data.fare,
      distance: data.distance,
      vehicleType: data.vehicleType,
      otp,
      status: 'SEARCHING'
    };

    socket.emit('ride-created', { rideId, otp });
    io.emit('new-ride-offer', {
      rideId,
      fare: data.fare,
      distance: data.distance,
      vehicleType: data.vehicleType
    });
  });

  // Driver Accept Ride
  socket.on('accept-ride', (data) => {
    const ride = rides[data.rideId];
    if (ride && ride.status === 'SEARCHING') {
      ride.driverSocketId = socket.id;
      ride.status = 'ACCEPTED';

      io.to(ride.riderSocketId).emit('driver-assigned', {
        driverId: socket.id,
        rideId: ride.rideId
      });
    }
  });

  // OTP Verification
  socket.on('verify-otp', (data) => {
    const ride = rides[data.rideId];
    if (ride && ride.otp === data.enteredOtp) {
      ride.status = 'IN_PROGRESS';
      socket.emit('otp-result', { success: true });
      io.to(ride.riderSocketId).emit('trip-started');
    } else {
      socket.emit('otp-result', { success: false });
    }
  });

  // Ride Finish & DB Save
  socket.on('complete-ride', (data) => {
    const ride = rides[data.rideId];
    if (ride) {
      ride.status = 'COMPLETED';
      db.run(
        `INSERT INTO rides (rider_phone, driver_phone, fare, distance, vehicle_type) VALUES (?, ?, ?, ?, ?)`,
        [ride.riderPhone, ride.driverPhone || 'Captain', ride.fare, ride.distance, ride.vehicleType],
        (err) => {
          if (err) console.error('Save Trip Error:', err.message);
        }
      );

      socket.emit('ride-finished-driver', { fare: ride.fare });
      io.to(ride.riderSocketId).emit('ride-finished-rider', { fare: ride.fare });
      delete rides[data.rideId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Nandi Ride Server Live on port ${PORT}`);
});