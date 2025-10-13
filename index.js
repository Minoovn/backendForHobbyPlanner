const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const app = express();
const port = 3000;
const nodemailer = require('nodemailer');
const dotenv = require("dotenv");
dotenv.config();

app.use(cors());
app.use(express.json());


// --------------------
// Nodemailer transporter
// --------------------
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587, // 🔹 از 465 به 587 تغییر داده شد
  secure: false, // 🔹 TLS خودش فعال میشه
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});


//...............
//َ OpenAI Setup
//...............
const OpenAI = require("openai");


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------------------
// Initialize database
// --------------------
const db = new Database('sessions.db');
//db.prepare('ALTER TABLE sessions ADD COLUMN email TEXT').run();
//console.log('✅ Added email column to sessions table');



// Check existing tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables in sessions.db:', tables);

// Create sessions table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    maxParticipants TEXT NOT NULL,
    type TEXT NOT NULL,
    managementCode TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )
`);

// Create attendees table
db.exec(`
  CREATE TABLE IF NOT EXISTS attendees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    registeredAt TEXT NOT NULL,
    attendanceCode TEXT NOT NULL,
    FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
  )
`);

// ✅ Safely add latitude & longitude columns if they don't exist
const tableInfo = db.prepare("PRAGMA table_info(sessions)").all();
const colNames = tableInfo.map(c => c.name);

if (!colNames.includes('latitude')) {
  db.prepare('ALTER TABLE sessions ADD COLUMN latitude REAL').run();
  console.log('Added column: latitude');
}
if (!colNames.includes('longitude')) {
  db.prepare('ALTER TABLE sessions ADD COLUMN longitude REAL').run();
  console.log('Added column: longitude');
}

// --------------------
// Routes
// --------------------

// Hello
app.get('/', (req, res) => {
  res.send('Hello from hobby planner!');
});

// Get all sessions
app.get('/sessions', (req, res) => {
  try {
    const sessions = db.prepare('SELECT * FROM sessions').all();
    const parsedSessions = sessions.map((session) => {
      const currentCount = db.prepare('SELECT COUNT(*) as total FROM attendees WHERE sessionId = ?').get(session.id).total;
      return {
        ...session,
        maxParticipants: Number(JSON.parse(session.maxParticipants)),
        currentParticipants: Number(currentCount),
        latitude: session.latitude,
        longitude: session.longitude
      };
    });
    res.json(parsedSessions);
  } catch (err) {
    console.error('Error fetching sessions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get session by ID
app.get('/sessions/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);

  if (session) {
    res.json({
      ...session,
      maxParticipants: Number(JSON.parse(session.maxParticipants)),
      latitude: session.latitude,
      longitude: session.longitude
    });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Create a new session
app.post('/sessions', (req, res) => {
  try {
    const { title, description, date, time, maxParticipants, type, managementCode, latitude, longitude, email } = req.body;
    const createdAt = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO sessions (title, description, date, time, maxParticipants, type, managementCode, createdAt, latitude, longitude, email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      title,
      description,
      date,
      time,
      JSON.stringify(maxParticipants),
      type,
      managementCode,
      createdAt,
      latitude ?? null,
      longitude ?? null,
      email
    );
    

    // ✉️ بعد از ساخت جلسه، ایمیل ارسال کن
    const manageLink = `http://localhost:5173/manage-session/${managementCode}`;

    transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your Hobby Session Management Link',
      text: `Hi!\n\nYour session "${title}" was created successfully.\n\nManage it here:\n${manageLink}\n\nKeep this link safe.`,
    });


    const newSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({
      ...newSession,
      maxParticipants: Number(JSON.parse(newSession.maxParticipants))
    });
  } catch (err) {
    console.error('Error creating session:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Join a session (add attendee) and send session link automatically
app.post('/sessions/:id/attendees', async (req, res) => {
  const sessionId = parseInt(req.params.id);
  const { firstName, lastName, email } = req.body;

  try {
    // ✅ Get session
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // ✅ Check if session is full
    const attendeeCount = db.prepare('SELECT COUNT(*) as total FROM attendees WHERE sessionId = ?').get(sessionId).total;
    if (attendeeCount >= Number(session.maxParticipants)) {
      return res.status(400).json({ error: 'Session is full' });
    }

    // ✅ Create attendee
    const attendanceCode = Math.random().toString(36).substring(2, 10);
    const registeredAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO attendees (sessionId, name, email, registeredAt, attendanceCode)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, `${firstName} ${lastName}`, email, registeredAt, attendanceCode);

    // ✅ Send session link email
    const sessionLink = `http://localhost:5173/attendee/${attendanceCode}`;
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Your session: ${session.title}`,
      text: `Hi ${firstName} ${lastName},\n\nHere is your session link:\n${sessionLink}\n\nSee you there!`,
      html: `<p>Hi ${firstName} ${lastName},</p>
             <p>Here is your session link: <a href="${sessionLink}">${sessionLink}</a></p>
             <p>See you there!</p>`
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error('❌ Error sending email:', err);
        // حتی اگر ایمیل ارسال نشد، کاربر ثبت شده
        return res.status(201).json({
          message: 'You are now attending the session! But email failed to send.',
          attendanceCode
        });
      }

      console.log('✅ Email sent:', info.response);
      res.status(201).json({ message: 'You are now attending the session! Email sent successfully.', attendanceCode });
    });

  } catch (err) {
    console.error('Error in /sessions/:id/attendees:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Get all attendees for a session
app.get('/sessions/:id/attendees', (req, res) => {
  const sessionId = parseInt(req.params.id);
  const attendees = db.prepare('SELECT * FROM attendees WHERE sessionId = ?').all(sessionId);
  res.json(attendees);
});

// Delete an attendee by attendanceCode
app.delete('/attendees/:code', (req, res) => {
  const { code } = req.params;
  const info = db.prepare('DELETE FROM attendees WHERE attendanceCode = ?').run(code);

  if (info.changes === 0) return res.status(404).json({ error: 'Invalid attendance code' });
  res.json({ message: 'You have left the session' });
});

// --------------------
// Attendee details
// --------------------
app.get('/attendees/:code', (req, res) => {
  const { code } = req.params;
  const attendee = db.prepare('SELECT * FROM attendees WHERE attendanceCode = ?').get(code);
  if (!attendee) return res.status(404).json({ error: 'Attendee not found' });
  res.json({ name: attendee.name, email: attendee.email,  sessionId: attendee.sessionId  });
});

app.put('/attendees/:code', (req, res) => {
  const { code } = req.params;
  const { name, email } = req.body;
  const attendee = db.prepare('SELECT * FROM attendees WHERE attendanceCode = ?').get(code);
  if (!attendee) return res.status(404).json({ error: 'Attendee not found' });

  db.prepare('UPDATE attendees SET name = ?, email = ? WHERE attendanceCode = ?')
    .run(name, email, code);

  res.json({ message: 'Attendee info updated successfully' });
});

// --------------------
// Management routes
// --------------------
app.get('/sessions/manage/:managementCode', (req, res) => {
  const { managementCode } = req.params;
  const session = db.prepare('SELECT * FROM sessions WHERE managementCode = ?').get(managementCode);

  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({
    ...session,
    maxParticipants: Number(JSON.parse(session.maxParticipants)),
    latitude: session.latitude,
    longitude: session.longitude
  });
});

app.get('/sessions/manage/:managementCode/attendees', (req, res) => {
  const { managementCode } = req.params;
  const session = db.prepare('SELECT * FROM sessions WHERE managementCode = ?').get(managementCode);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const attendees = db.prepare('SELECT * FROM attendees WHERE sessionId = ?').all(session.id);
  res.json(attendees);
});

// ✅ Update session (with map support)
app.put('/sessions/manage/:managementCode', (req, res) => {
  const { managementCode } = req.params;
  const { title, description, date, time, maxParticipants, type, latitude, longitude } = req.body;

  const session = db.prepare('SELECT * FROM sessions WHERE managementCode = ?').get(managementCode);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  db.prepare(`
    UPDATE sessions
    SET title = ?, description = ?, date = ?, time = ?, maxParticipants = ?, type = ?, latitude = ?, longitude = ?
    WHERE managementCode = ?
  `).run(
    title,
    description,
    date,
    time,
    JSON.stringify(maxParticipants),
    type,
    latitude ?? null,
    longitude ?? null,
    managementCode
  );

  const updatedSession = db.prepare('SELECT * FROM sessions WHERE managementCode = ?').get(managementCode);
  res.json({
    ...updatedSession,
    maxParticipants: Number(JSON.parse(updatedSession.maxParticipants))
  });
});

// Delete session
app.delete('/sessions/manage/:managementCode', (req, res) => {
  const { managementCode } = req.params;
  const session = db.prepare('SELECT * FROM sessions WHERE managementCode = ?').get(managementCode);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  db.prepare('DELETE FROM sessions WHERE managementCode = ?').run(managementCode);
  db.prepare('DELETE FROM attendees WHERE sessionId = ?').run(session.id);

  res.json({ message: 'Session deleted successfully' });
});



// --------------------
// AI-powered session description
// --------------------
app.post("/api/suggest-session", async (req, res) => {
  try {
    const { prompt } = req.body;
    console.log("API Key:", process.env.OPENAI_API_KEY ? "✅ exists" : "❌ missing");
    console.log("Received prompt:", prompt);

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "user", content: prompt || "Suggest a fun hobby session for next week." }
      ],
    });

    const suggestionText = response.choices[0].message.content;
    console.log("OpenAI response:", suggestionText);

    res.json({ suggestion: suggestionText });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate suggestion" });
  }
});



// --------------------
// Start server
// --------------------
app.listen(port, () => {
  console.log(`✅ Hobby sessions server running on http://localhost:${port}`);

  transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email transporter failed:', error);
  } else {
    console.log('✅ Email transporter is ready to send messages');
  }
});

});
