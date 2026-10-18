const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 10000;
const ADMIN_SUPPORT_PHONE = "8130121347";
const COMMISSION_RATE = 0.03; // 3% Captain platform fee

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// SQLite Database Setup
const db = new sqlite3.Database('./rides.db', (err) => {
  if (err) console.error("Database connection error:", err);
  else console.log("SQLite Database Connected for Nandi Ride.");
});

// Database Tables Initialization
db.serialize(() => {
  // Captains Table (Unique vehicle & phone)
  db.run(`CREATE TABLE IF NOT EXISTS captains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT UNIQUE,
    vehicle_type TEXT,
    vehicle_no TEXT UNIQUE,
    pan_no TEXT,
    aadhar_no TEXT UNIQUE,
    photo TEXT,
    wallet_balance REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Riders Table (Unique phone & aadhar)
  db.run(`CREATE TABLE IF NOT EXISTS riders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT UNIQUE,
    aadhar_no TEXT UNIQUE,
    wallet_balance REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Rides Table
  db.run(`CREATE TABLE IF NOT EXISTS rides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rider_phone TEXT,
    rider_name TEXT,
    captain_id INTEGER,
    captain_name TEXT,
    captain_phone TEXT,
    vehicle_no TEXT,
    pickup TEXT,
    dropoff TEXT,
    fare REAL,
    commission REAL DEFAULT 0,
    otp TEXT,
    status TEXT DEFAULT 'pending', -- pending, accepted, ongoing, completed, cancelled
    payment_mode TEXT DEFAULT 'CASH',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Admin Wallet Table (For 3% platform commission earnings)
  db.run(`CREATE TABLE IF NOT EXISTS admin_wallet (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    balance REAL DEFAULT 0
  )`);

  db.run(`INSERT INTO admin_wallet (id, balance) SELECT 1, 0 WHERE NOT EXISTS (SELECT 1 FROM admin_wallet WHERE id = 1)`);
});

// APIs
// Captain Registration
app.post('/api/captain/register', (req, res) => {
  const { name, phone, vehicle_type, vehicle_no, pan_no, aadhar_no, photo } = req.body;
  const sql = `INSERT INTO captains (name, phone, vehicle_type, vehicle_no, pan_no, aadhar_no, photo, wallet_balance) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`;
  db.run(sql, [name, phone, vehicle_type, vehicle_no.toUpperCase().trim(), pan_no.toUpperCase().trim(), aadhar_no.trim(), photo], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ success: false, message: "Vehicle No, Phone ya Aadhar pehle se registered hai!" });
      }
      return res.status(500).json({ success: false, message: err.message });
    }
    res.json({ success: true, captainId: this.lastID });
  });
});

// Rider Registration
app.post('/api/rider/register', (req, res) => {
  const { name, phone, aadhar_no } = req.body;
  const sql = `INSERT INTO riders (name, phone, aadhar_no, wallet_balance) VALUES (?, ?, ?, 0)`;
  db.run(sql, [name, phone, aadhar_no.trim()], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(400).json({ success: false, message: "Aadhar No ya Phone Number pehle se registered hai!" });
      }
      return res.status(500).json({ success: false, message: err.message });
    }
    res.json({ success: true, riderId: this.lastID });
  });
});

// Fetch Captain Details
app.get('/api/captain/:phone', (req, res) => {
  db.get(`SELECT * FROM captains WHERE phone = ?`, [req.params.phone], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false, message: "Captain nahi mila" });
    res.json({ success: true, data: row });
  });
});

// Fetch Rider Details
app.get('/api/rider/:phone', (req, res) => {
  db.get(`SELECT * FROM riders WHERE phone = ?`, [req.params.phone], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false, message: "Rider nahi mila" });
    res.json({ success: true, data: row });
  });
});

// Admin Wallet Details
app.get('/api/admin/wallet', (req, res) => {
  db.get(`SELECT balance FROM admin_wallet WHERE id = 1`, (err, row) => {
    res.json({ balance: row ? row.balance : 0, support_phone: ADMIN_SUPPORT_PHONE });
  });
});

// Socket.io Real-Time Workflows
io.on('connection', (socket) => {

  // Location Sync
  socket.on('update_location', (data) => {
    socket.broadcast.emit(`location_${data.rideId}`, data);
  });

  // Ride Request
  socket.on('request_ride', (data) => {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const commission = data.fare * COMMISSION_RATE;

    const sql = `INSERT INTO rides (rider_phone, rider_name, pickup, dropoff, fare, commission, otp, status, payment_mode) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`;
    db.run(sql, [data.riderPhone, data.riderName, data.pickup, data.dropoff, data.fare, commission, otp, data.paymentMode], function(err) {
      if (!err) {
        const rideData = { ...data, rideId: this.lastID, otp, commission };
        io.emit('new_ride_available', rideData);
        socket.emit('ride_created', { rideId: this.lastID, otp });
      }
    });
  });

  // Accept Ride by Captain
  socket.on('accept_ride', (data) => {
    const sql = `UPDATE rides SET captain_id = ?, captain_name = ?, captain_phone = ?, vehicle_no = ?, status = 'accepted' WHERE id = ? AND status = 'pending'`;
    db.run(sql, [data.captainId, data.captainName, data.captainPhone, data.vehicleNo, data.rideId], function(err) {
      if (!err && this.changes > 0) {
        io.emit(`ride_matched_${data.rideId}`, data);
      }
    });
  });

  // Verify OTP & Start Ride
  socket.on('verify_otp_start', (data) => {
    db.get(`SELECT * FROM rides WHERE id = ?`, [data.rideId], (err, ride) => {
      if (ride && ride.otp === data.otp) {
        db.run(`UPDATE rides SET status = 'ongoing' WHERE id = ?`, [data.rideId]);
        io.emit(`ride_started_${data.rideId}`, { success: true });
      } else {
        socket.emit('otp_error', { message: "Galat OTP! Kripya sahi OTP daalein." });
      }
    });
  });

  // Cancel Ride (Allowed only before OTP is verified)
  socket.on('cancel_ride', (data) => {
    db.get(`SELECT status FROM rides WHERE id = ?`, [data.rideId], (err, ride) => {
      if (ride && ride.status !== 'ongoing' && ride.status !== 'completed') {
        db.run(`UPDATE rides SET status = 'cancelled' WHERE id = ?`, [data.rideId]);
        io.emit(`ride_cancelled_${data.rideId}`, { cancelledBy: data.cancelledBy });
      }
    });
  });

  // In-App Ephemeral Chat during Ride
  socket.on('send_chat_msg', (data) => {
    io.emit(`chat_msg_${data.rideId}`, { sender: data.sender, text: data.text });
  });

  // Complete Ride & Deduct 3% Commission
  socket.on('complete_ride', (data) => {
    db.get(`SELECT * FROM rides WHERE id = ?`, [data.rideId], (err, ride) => {
      if (ride && ride.status === 'ongoing') {
        const comm = ride.commission;
        db.run(`UPDATE rides SET status = 'completed' WHERE id = ?`, [data.rideId]);
        // Update Admin Wallet with 3%
        db.run(`UPDATE admin_wallet SET balance = balance + ? WHERE id = 1`, [comm]);
        // Deduct fee from Captain balance
        db.run(`UPDATE captains SET wallet_balance = wallet_balance - ? WHERE id = ?`, [comm, ride.captain_id]);
        
        io.emit(`ride_completed_${data.rideId}`, { fare: ride.fare, commission: comm });
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Nandi Ride Server Live on port ${PORT}`);
});