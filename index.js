const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 3000;
const nodemailer = require('nodemailer');
const dotenv = require("dotenv");
dotenv.config();

app.use(cors());
app.use(express.json());

// --------------------
// PostgreSQL setup (Azure Flexible Server friendly)
// --------------------
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  ssl: { rejectUnauthorized: false } // Azure معمولاً SSL نیاز داره
});

// helper: run a query and log error
async function runQuery(query, params = []) {
  try {
    return await pool.query(query, params);
  } catch (err) {
    console.error('Database query error:', err, query, params);
    throw err;
  }
}

// --------------------
// Nodemailer transporter
// --------------------
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// --------------------
// OpenAI Setup
// --------------------
const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------------------
// Ensure tables exist (runs at startup)
// --------------------
async function ensureTables() {
  // sessions table
  await runQuery(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      maxParticipants INTEGER NOT NULL,
      type TEXT NOT NULL,
      managementCode TEXT NOT NULL,
      createdAt TIMESTAMP NOT NULL,
      latitude REAL,
      longitude REAL,
      email TEXT
    );
  `);

  // attendees table
  await runQuery(`
    CREATE TABLE IF NOT EXISTS attendees (
      id SERIAL PRIMARY KEY,
      sessionId INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      registeredAt TIMESTAMP NOT NULL,
      attendanceCode TEXT NOT NULL
    );
  `);
}

// --------------------
// Routes
// --------------------

// Hello
app.get('/', (req, res) => {
  res.send('Hello from hobby planner (Postgres version)!');
});

// Get all sessions
app.get('/sessions', async (req, res) => {
  try {
    const result = await runQuery('SELECT * FROM sessions ORDER BY id DESC');
    const sessions = result.rows;

    const parsedSessions = await Promise.all(sessions.map(async (session) => {
      const countResult = await runQuery('SELECT COUNT(*) FROM attendees WHERE sessionId = $1', [session.id]);
      const currentCount = parseInt(countResult.rows[0].count, 10);

      return {
        ...session,
        maxParticipants: Number(session.maxparticipants),
        currentParticipants: Number(currentCount),
        latitude: session.latitude,
        longitude: session.longitude
      };
    }));

    res.json(parsedSessions);
  } catch (err) {
    console.error('Error fetching sessions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get session by ID
app.get('/sessions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await runQuery('SELECT * FROM sessions WHERE id = $1', [id]);
    const session = result.rows[0];

    if (session) {
      res.json({
        ...session,
        maxParticipants: Number(session.maxparticipants),
        latitude: session.latitude,
        longitude: session.longitude
      });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  } catch (err) {
    console.error('Error in GET /sessions/:id', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new session
app.post('/sessions', async (req, res) => {
  try {
    const { title, description, date, time, maxParticipants, type, managementCode, latitude, longitude, email } = req.body;
    const createdAt = new Date().toISOString();

    const insertQuery = `
      INSERT INTO sessions
      (title, description, date, time, maxParticipants, type, managementCode, createdAt, latitude, longitude, email)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `;
    const values = [
      title,
      description,
      date,
      time,
      Number(maxParticipants) || 0,
      type,
      managementCode,
      createdAt,
      latitude ?? null,
      longitude ?? null,
      email ?? null
    ];

    const newSessionResult = await runQuery(insertQuery, values);
    const newSession = newSessionResult.rows[0];

    // Send management email (non-blocking: but we'll await to report status)
    if (email) {
      const manageLink = `http://localhost:5173/manage-session/${managementCode}`;
      try {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: email,
          subject: 'Your Hobby Session Management Link',
          text: `Hi!\n\nYour session "${title}" was created successfully.\n\nManage it here:\n${manageLink}\n\nKeep this link safe.`,
        });
      } catch (mailErr) {
        console.error('Error sending management email:', mailErr);
        // continue - we still return created session
      }
    }

    res.status(201).json({
      ...newSession,
      maxParticipants: Number(newSession.maxparticipants)
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
    // Get session
    const sessionResult = await runQuery('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    const session = sessionResult.rows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Check if session is full
    const countResult = await runQuery('SELECT COUNT(*) FROM attendees WHERE sessionId = $1', [sessionId]);
    const attendeeCount = parseInt(countResult.rows[0].count, 10);
    if (attendeeCount >= Number(session.maxparticipants)) {
      return res.status(400).json({ error: 'Session is full' });
    }

    // Create attendee
    const attendanceCode = Math.random().toString(36).substring(2, 10);
    const registeredAt = new Date().toISOString();
    await runQuery(
      'INSERT INTO attendees (sessionId, name, email, registeredAt, attendanceCode) VALUES ($1,$2,$3,$4,$5)',
      [sessionId, `${firstName} ${lastName}`, email, registeredAt, attendanceCode]
    );

    // Send session link email
    if (email) {
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

      try {
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Email sent:', info.response);
        return res.status(201).json({ message: 'You are now attending the session! Email sent successfully.', attendanceCode });
      } catch (err) {
        console.error('❌ Error sending email:', err);
        return res.status(201).json({
          message: 'You are now attending the session! But email failed to send.',
          attendanceCode
        });
      }
    } else {
      // No email provided
      return res.status(201).json({ message: 'You are now attending the session!', attendanceCode });
    }

  } catch (err) {
    console.error('Error in /sessions/:id/attendees:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all attendees for a session
app.get('/sessions/:id/attendees', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const attendeesResult = await runQuery('SELECT * FROM attendees WHERE sessionId = $1', [sessionId]);
    res.json(attendeesResult.rows);
  } catch (err) {
    console.error('Error in GET /sessions/:id/attendees', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete an attendee by attendanceCode
app.delete('/attendees/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const info = await runQuery('DELETE FROM attendees WHERE attendanceCode = $1 RETURNING *', [code]);

    if (info.rowCount === 0) return res.status(404).json({ error: 'Invalid attendance code' });
    res.json({ message: 'You have left the session' });
  } catch (err) {
    console.error('Error deleting attendee:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --------------------
// Attendee details
// --------------------
app.get('/attendees/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const att = await runQuery('SELECT * FROM attendees WHERE attendanceCode = $1', [code]);
    const attendee = att.rows[0];
    if (!attendee) return res.status(404).json({ error: 'Attendee not found' });
    res.json({ name: attendee.name, email: attendee.email, sessionId: attendee.sessionid });
  } catch (err) {
    console.error('Error in GET /attendees/:code', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/attendees/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { name, email } = req.body;
    const att = await runQuery('SELECT * FROM attendees WHERE attendanceCode = $1', [code]);
    const attendee = att.rows[0];
    if (!attendee) return res.status(404).json({ error: 'Attendee not found' });

    await runQuery('UPDATE attendees SET name = $1, email = $2 WHERE attendanceCode = $3', [name, email, code]);
    res.json({ message: 'Attendee info updated successfully' });
  } catch (err) {
    console.error('Error in PUT /attendees/:code', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --------------------
// Management routes
// --------------------
app.get('/sessions/manage/:managementCode', async (req, res) => {
  try {
    const { managementCode } = req.params;
    const result = await runQuery('SELECT * FROM sessions WHERE managementCode = $1', [managementCode]);
    const session = result.rows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });

    res.json({
      ...session,
      maxParticipants: Number(session.maxparticipants),
      latitude: session.latitude,
      longitude: session.longitude
    });
  } catch (err) {
    console.error('Error in GET /sessions/manage/:managementCode', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/sessions/manage/:managementCode/attendees', async (req, res) => {
  try {
    const { managementCode } = req.params;
    const sessionRes = await runQuery('SELECT * FROM sessions WHERE managementCode = $1', [managementCode]);
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const attendees = await runQuery('SELECT * FROM attendees WHERE sessionId = $1', [session.id]);
    res.json(attendees.rows);
  } catch (err) {
    console.error('Error in GET /sessions/manage/:managementCode/attendees', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update session (with map support)
app.put('/sessions/manage/:managementCode', async (req, res) => {
  try {
    const { managementCode } = req.params;
    const { title, description, date, time, maxParticipants, type, latitude, longitude } = req.body;

    const sessionRes = await runQuery('SELECT * FROM sessions WHERE managementCode = $1', [managementCode]);
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });

    await runQuery(
      `UPDATE sessions
       SET title = $1, description = $2, date = $3, time = $4, maxParticipants = $5, type = $6, latitude = $7, longitude = $8
       WHERE managementCode = $9`,
      [title, description, date, time, Number(maxParticipants) || 0, type, latitude ?? null, longitude ?? null, managementCode]
    );

    const updated = await runQuery('SELECT * FROM sessions WHERE managementCode = $1', [managementCode]);
    const updatedSession = updated.rows[0];
    res.json({
      ...updatedSession,
      maxParticipants: Number(updatedSession.maxparticipants)
    });
  } catch (err) {
    console.error('Error in PUT /sessions/manage/:managementCode', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete session
app.delete('/sessions/manage/:managementCode', async (req, res) => {
  try {
    const { managementCode } = req.params;
    const sessionRes = await runQuery('SELECT * FROM sessions WHERE managementCode = $1', [managementCode]);
    const session = sessionRes.rows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });

    await runQuery('DELETE FROM attendees WHERE sessionId = $1', [session.id]);
    await runQuery('DELETE FROM sessions WHERE managementCode = $1', [managementCode]);

    res.json({ message: 'Session deleted successfully' });
  } catch (err) {
    console.error('Error deleting session:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --------------------
// AI-powered session description
// --------------------
app.post("/api/suggest-session", async (req, res) => {
  try {
    const { prompt } = req.body;
    console.log("API Key:", process.env.OPENAI_API_KEY ? "✅ exists" : "❌ missing");
    console.log("Received prompt:", prompt);

    // using same style as your previous code - chat completions
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
    console.error('OpenAI error:', error);
    res.status(500).json({ error: "Failed to generate suggestion" });
  }
});

// --------------------
// Start server
// --------------------
(async function start() {
  try {
    await ensureTables();
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
  } catch (err) {
    console.error('Error during startup:', err);
    process.exit(1);
  }
})();
