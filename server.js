const express = require('express');
const session = require('express-session');
const path = require('path');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== APP CONFIG ====================
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'credity-secret-key-2026-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

// ==================== DATABASE / PERSISTENCE ====================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'credity-db.json');

let users = [
  { id: 1, email: 'teacher@school.com', password: 'pass123', role: 'teacher', name: 'Ms. Johnson' },
  { id: 2, email: 'student@school.com', password: 'pass123', role: 'student', name: 'Alex Rivera' }
];

let credentialTemplates = [];
let issuedCredentials = [];
let events = [];
let tests = [];
let networkLogs = [];
let studentKeys = [];
let classEnrollments = [];
let submissions = [];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveDB() {
  try {
    ensureDataDir();
    const db = {
      users,
      credentialTemplates,
      issuedCredentials,
      events,
      tests,
      networkLogs,
      studentKeys,
      classEnrollments,
      submissions
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('DB save error:', err.message);
  }
}

function loadDB() {
  try {
    ensureDataDir();
    if (!fs.existsSync(DB_FILE)) {
      saveDB();
      return;
    }

    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

    users = Array.isArray(db.users) && db.users.length ? db.users : users;
    credentialTemplates = Array.isArray(db.credentialTemplates) ? db.credentialTemplates : [];
    issuedCredentials = Array.isArray(db.issuedCredentials) ? db.issuedCredentials : [];
    events = Array.isArray(db.events) ? db.events : [];
    tests = Array.isArray(db.tests) ? db.tests : [];
    networkLogs = Array.isArray(db.networkLogs) ? db.networkLogs : [];
    studentKeys = Array.isArray(db.studentKeys) ? db.studentKeys : [];
    classEnrollments = Array.isArray(db.classEnrollments) ? db.classEnrollments : [];
    submissions = Array.isArray(db.submissions) ? db.submissions : [];
  } catch (err) {
    console.error('DB load error:', err.message);
  }
}

loadDB();

// ==================== MAILER ====================
// Put these in Render environment variables:
// GMAIL_USER=credifysupport@gmail.com
// GMAIL_APP_PASSWORD=your-new-google-app-password
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';

let transporter = null;

if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD
    }
  });
} else {
  console.log('Mailer disabled: missing GMAIL_USER or GMAIL_APP_PASSWORD.');
}

// ==================== HELPERS ====================
function nextId(arr, field = 'id') {
  if (!Array.isArray(arr) || arr.length === 0) return 1;
  return Math.max(...arr.map(x => Number(x[field]) || 0)) + 1;
}

function currentUser(req) {
  if (!req.session.user) return null;
  return users.find(u => u.id === req.session.user.id) || req.session.user;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

function requireTeacher(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'teacher') return res.redirect('/');
  next();
}

function requireStudent(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'student') return res.redirect('/');
  next();
}

function isAdminUser(user) {
  return user && (user.email === 'admin' || user.id === 0);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function absoluteUrl(req, route) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers.host || 'credity.ink';
  return `${protocol}://${host}${route}`;
}

async function generateQR(text) {
  try {
    return await QRCode.toDataURL(text);
  } catch (err) {
    console.error('QR generation failed:', err.message);
    return '';
  }
}

function generateCredentialHash(userId, assessmentId) {
  const raw = `${userId}-${assessmentId}-${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 24);
}

function normalizeAccessKey(key) {
  return String(key || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function generateStudentAccessKey() {
  let key;
  let normalized;

  do {
    const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
    const part3 = crypto.randomBytes(2).toString('hex').toUpperCase();
    key = `CRED-${part1}-${part2}-${part3}`;
    normalized = normalizeAccessKey(key);
  } while (studentKeys.some(k => k.normalizedKey === normalized));

  return { key, normalized };
}

async function sendEmail(to, subject, html) {
  if (!transporter) return;

  try {
    await transporter.sendMail({
      from: `"Credity" <${GMAIL_USER}>`,
      to,
      subject,
      html
    });
  } catch (err) {
    console.log('Email error:', err.message);
  }
}

function parseQuestions(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function collectLogoUrls(bodyValue) {
  const raw = bodyValue;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map(x => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

function teacherOwnsTest(teacherId, testId) {
  return tests.find(t => Number(t.id) === Number(testId) && Number(t.teacherId) === Number(teacherId));
}

function teacherOwnsBadge(teacherId, badgeId) {
  return credentialTemplates.find(b =>
    Number(b.id) === Number(badgeId) &&
    Number(b.teacherId) === Number(teacherId)
  );
}

function latestTeacherBadge(teacherId) {
  return [...credentialTemplates]
    .reverse()
    .find(b => Number(b.teacherId) === Number(teacherId));
}

function studentHasAccessToTest(userId, test) {
  if (!test) return false;

  // Old/demo tests stay open unless a key was generated for them.
  if (!test.requiresKey) return true;

  return classEnrollments.some(e =>
    Number(e.userId) === Number(userId) &&
    Number(e.testId) === Number(test.id)
  );
}

function mapIssuedCredentialForStudent(credential) {
  return {
    ...credential,
    id: credential.issuedId,
    badgeId: credential.verifyHash,
    title: credential.title || 'Skill Badge',
    issuedDate: credential.issueDate || credential.issuedDate || '',
    createdBy: credential.createdBy || 'School Admin',
    qrCode: credential.qrCode || ''
  };
}

function makeConfirmationPage(title, message, buttons = []) {
  const buttonHtml = buttons.map(btn => {
    return `<a href="${escapeHtml(btn.href)}" style="display:inline-block;margin:8px;padding:12px 18px;border-radius:999px;background:${btn.primary ? '#fff' : 'rgba(255,255,255,.08)'};color:${btn.primary ? '#09090b' : '#fff'};text-decoration:none;font-weight:700;font-size:13px;border:1px solid rgba(255,255,255,.15)">${escapeHtml(btn.label)}</a>`;
  }).join('');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(title)} • Credity</title>
      <style>
        body {
          margin: 0;
          min-height: 100vh;
          background: #09090b;
          color: white;
          font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          display: grid;
          place-items: center;
          padding: 24px;
        }
        .card {
          max-width: 620px;
          width: 100%;
          border: 1px solid rgba(255,255,255,.12);
          background: rgba(255,255,255,.05);
          border-radius: 32px;
          padding: 34px;
          box-shadow: 0 30px 100px rgba(0,0,0,.35);
        }
        .eyebrow {
          color: #34d399;
          font-size: 12px;
          letter-spacing: 2px;
          text-transform: uppercase;
          font-weight: 800;
          margin-bottom: 10px;
        }
        h1 {
          margin: 0 0 12px;
          font-size: 34px;
          letter-spacing: -0.04em;
        }
        p {
          color: rgba(255,255,255,.68);
          line-height: 1.6;
        }
        code {
          display: block;
          margin: 18px 0;
          padding: 18px;
          border-radius: 20px;
          background: #18181b;
          border: 1px solid rgba(255,255,255,.12);
          color: #a7f3d0;
          font-size: 22px;
          font-weight: 900;
          letter-spacing: .08em;
          text-align: center;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="eyebrow">Credity</div>
        <h1>${escapeHtml(title)}</h1>
        <p>${message}</p>
        <div>${buttonHtml}</div>
      </div>
    </body>
    </html>
  `;
}

// ==================== AUTH ROUTES ====================
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
  }

  res.render('index', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password, role } = req.body;

  if (email === 'admin' && password === 'monterysasd') {
    req.session.user = { id: 0, email: 'admin', role: 'teacher', name: 'Admin' };
    return res.redirect('/admin');
  }

  const user = users.find(u =>
    String(u.email).toLowerCase() === String(email || '').toLowerCase() &&
    u.password === password &&
    u.role === role
  );

  if (user) {
    req.session.user = user;
    return res.redirect(user.role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
  }

  res.render('index', { error: 'Invalid credentials.' });
});

app.post('/signup', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.render('index', { error: 'Please fill all fields.' });
  }

  if (!['teacher', 'student'].includes(role)) {
    return res.render('index', { error: 'Invalid role.' });
  }

  if (users.find(u => String(u.email).toLowerCase() === String(email).toLowerCase())) {
    return res.render('index', { error: 'Email exists.' });
  }

  const newUser = {
    id: nextId(users),
    email: String(email).trim().toLowerCase(),
    password,
    role,
    name: String(name).trim()
  };

  users.push(newUser);
  saveDB();

  req.session.user = newUser;

  await sendEmail(
    newUser.email,
    'Welcome to Credity',
    `<p>Hello ${escapeHtml(newUser.name)}, your account was created.</p>`
  );

  res.redirect(role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// ==================== DASHBOARDS ====================
app.get('/student-dashboard', requireStudent, (req, res) => {
  const user = currentUser(req);

  const userCredentials = issuedCredentials
    .filter(c => Number(c.userId) === Number(user.id))
    .map(mapIssuedCredentialForStudent);

  const studentEnrollments = classEnrollments.filter(e => Number(e.userId) === Number(user.id));

  const visibleTests = tests
    .filter(t => studentHasAccessToTest(user.id, t))
    .map(t => {
      let countdown = 0;

      if (t.examStartTime && !t.isOpen) {
        const start = new Date(t.examStartTime);
        const now = new Date();
        const diff = start.getTime() - now.getTime();
        countdown = diff > 0 ? Math.floor(diff / 1000) : 0;
      }

      return { ...t, countdown };
    });

  const classEventCards = studentEnrollments.map(e => ({
    id: `class-${e.id}`,
    title: `Unlocked: ${e.testTitle || 'Assessment'}`,
    description: `Class group: ${e.className}. Test link: /take-test/${e.testId}`,
    date: new Date(e.joinedAt).toLocaleDateString(),
    specialBadgeId: null
  }));

  res.render('student-dashboard', {
    user,
    badges: userCredentials,
    issuedCredentials: userCredentials,
    events: [...classEventCards, ...events],
    tests: visibleTests,
    upcomingExams: visibleTests,
    enrollments: studentEnrollments
  });
});

app.get('/teacher-dashboard', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const teacherTests = tests.filter(t => Number(t.teacherId) === Number(user.id));
  const teacherBadges = credentialTemplates.filter(t => Number(t.teacherId) === Number(user.id));
  const teacherEvents = events.filter(e => !e.teacherId || Number(e.teacherId) === Number(user.id));
  const teacherKeys = studentKeys.filter(k => Number(k.teacherId) === Number(user.id));

  res.render('teacher-dashboard', {
    user,
    badges: teacherBadges,
    tests: teacherTests,
    events: teacherEvents,
    studentKeys: teacherKeys
  });
});

app.get('/admin', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const teacherTests = isAdminUser(user)
    ? tests
    : tests.filter(t => Number(t.teacherId) === Number(user.id));

  const teacherBadges = isAdminUser(user)
    ? credentialTemplates
    : credentialTemplates.filter(t => Number(t.teacherId) === Number(user.id));

  res.render('admin', {
    user,
    badges: teacherBadges,
    tests: teacherTests,
    issuedBadges: issuedCredentials,
    users,
    studentKeys,
    classEnrollments,
    events
  });
});

// ==================== BADGE / CREDENTIAL CREATION ====================
function createCredentialTemplate(req, res) {
  const user = currentUser(req);

  const assessmentId = req.body.assessmentId
    ? parseInt(req.body.assessmentId)
    : null;

  const templateId = nextId(credentialTemplates, 'templateId');
  const logos = collectLogoUrls(req.body.logoUrl);

  const newTemplate = {
    id: templateId,
    templateId,
    teacherId: user.id,
    type: req.body.type || 'badge',
    assessmentId,
    title: req.body.title || 'Skill Badge',
    designColor: req.body.designColor || '#6366f1',
    description: req.body.description || '',
    signature: req.body.signature || user.name,
    badgeIcon: req.body.badgeIcon || '',
    logos,
    logoUrl: logos[0] || '',
    useQR: req.body.useQR !== 'false',
    createdBy: user.name,
    createdAt: new Date().toISOString()
  };

  credentialTemplates.push(newTemplate);

  if (assessmentId) {
    const test = teacherOwnsTest(user.id, assessmentId);
    if (test) {
      test.attachedCredentialTemplateId = newTemplate.templateId;
    }
  }

  saveDB();

  res.redirect(isAdminUser(user) ? '/admin' : '/teacher-dashboard');
}

app.post('/create-badge', requireTeacher, createCredentialTemplate);
app.post('/create-credential', requireTeacher, createCredentialTemplate);

// ==================== EVENTS ====================
app.post('/post-event', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const specialBadgeId = req.body.specialBadgeId
    ? parseInt(req.body.specialBadgeId)
    : null;

  if (specialBadgeId && !teacherOwnsBadge(user.id, specialBadgeId)) {
    return res.status(403).send('You can only attach your own badges.');
  }

  const newEvent = {
    id: nextId(events),
    teacherId: user.id,
    title: req.body.title || 'Special Event',
    description: req.body.description || '',
    specialBadgeId,
    date: new Date().toLocaleDateString(),
    createdBy: user.name,
    createdAt: new Date().toISOString()
  };

  events.push(newEvent);
  saveDB();

  res.redirect(isAdminUser(user) ? '/admin' : '/teacher-dashboard');
});

// ==================== TEST CREATION ====================
function createTestFromBody(req, res) {
  const user = currentUser(req);
  const questions = parseQuestions(req.body.questions);
  const hasGraphData = questions.some(q => q.graphData !== undefined);

  const requestedTemplateId = req.body.attachedCredentialTemplateId
    ? parseInt(req.body.attachedCredentialTemplateId)
    : null;

  let attachedCredentialTemplateId = null;

  if (requestedTemplateId) {
    const ownedTemplate = teacherOwnsBadge(user.id, requestedTemplateId);
    if (ownedTemplate) attachedCredentialTemplateId = ownedTemplate.templateId;
  } else {
    const latest = latestTeacherBadge(user.id);
    if (latest) attachedCredentialTemplateId = latest.templateId;
  }

  const newTest = {
    id: nextId(tests),
    teacherId: user.id,
    title: req.body.title || 'Untitled Assessment',
    questions,
    questionType: req.body.questionType || 'mixed',
    timePerQuestion: parseInt(req.body.timePerQuestion) || 60,
    topics: req.body.topics || '',
    resources: req.body.resources || '',
    hasGraph: hasGraphData,
    calculatorEnabled: req.body.calculatorEnabled !== 'false',
    attachedCredentialTemplateId,

    isOpen: req.body.isOpen === 'true' || !req.body.examStartTime,
    examStartTime: req.body.examStartTime || null,
    examEndTime: req.body.examEndTime || null,
    teacherTimezone: req.body.teacherTimezone || 'Asia/Dubai',

    requiresKey: false,
    classKeyIds: [],

    showResultsAfterReview: req.body.showResultsAfterReview === 'true',
    networkLoggingEnabled: true,
    createdBy: user.name,
    dateCreated: new Date().toISOString()
  };

  tests.push(newTest);
  saveDB();

  if (newTest.examStartTime && !newTest.isOpen) {
    console.log(`[SCHEDULED] Exam "${newTest.title}" starts at ${newTest.examStartTime} (${newTest.teacherTimezone})`);
  }

  res.redirect(isAdminUser(user) ? '/admin' : '/teacher-dashboard');
}

app.get('/assessment', requireTeacher, (req, res) => {
  const user = currentUser(req);
  const teacherTemplates = credentialTemplates.filter(t => Number(t.teacherId) === Number(user.id));

  res.render('assessment', {
    templates: teacherTemplates,
    user
  });
});

app.post('/assessment', requireTeacher, createTestFromBody);
app.post('/create-test', requireTeacher, createTestFromBody);

// ==================== STUDENT / CLASS KEYS ====================
app.post('/generate-student-key', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const className = String(req.body.className || '').trim();
  const testId = parseInt(req.body.testId);

  if (!className) {
    return res.status(400).send('Class name is required.');
  }

  const test = teacherOwnsTest(user.id, testId);
  if (!test) {
    return res.status(403).send('Invalid test selected.');
  }

  const { key, normalized } = generateStudentAccessKey();

  const keyRecord = {
    id: nextId(studentKeys),
    key,
    normalizedKey: normalized,
    teacherId: user.id,
    teacherName: user.name,
    className,
    testId: test.id,
    testTitle: test.title,
    active: true,
    usageCount: 0,
    maxUses: null,
    createdAt: new Date().toISOString()
  };

  studentKeys.push(keyRecord);

  test.requiresKey = true;
  if (!Array.isArray(test.classKeyIds)) test.classKeyIds = [];
  test.classKeyIds.push(keyRecord.id);

  if (!test.attachedCredentialTemplateId) {
    const latest = latestTeacherBadge(user.id);
    if (latest) test.attachedCredentialTemplateId = latest.templateId;
  }

  saveDB();

  res.send(makeConfirmationPage(
    'Student Key Generated',
    `Share this key with your students. When they paste it in their dashboard, they will be enrolled into <strong>${escapeHtml(className)}</strong> and assigned <strong>${escapeHtml(test.title)}</strong>. <code>${escapeHtml(key)}</code>`,
    [
      { label: 'Back to Teacher Dashboard', href: '/teacher-dashboard', primary: true },
      { label: 'Open Test', href: `/take-test/${test.id}`, primary: false }
    ]
  ));
});

app.post('/join-class', requireStudent, async (req, res) => {
  const user = currentUser(req);
  const inputKey = normalizeAccessKey(req.body.studentKey);

  const keyRecord = studentKeys.find(k =>
    k.normalizedKey === inputKey &&
    k.active !== false
  );

  if (!keyRecord) {
    return res.status(404).send(makeConfirmationPage(
      'Invalid Student Key',
      'That key does not exist or is no longer active. Check the key from your teacher and try again.',
      [
        { label: 'Back to Student Dashboard', href: '/student-dashboard', primary: true }
      ]
    ));
  }

  const test = tests.find(t => Number(t.id) === Number(keyRecord.testId));
  if (!test) {
    return res.status(404).send(makeConfirmationPage(
      'Assigned Test Missing',
      'This key exists, but the assessment connected to it could not be found.',
      [
        { label: 'Back to Student Dashboard', href: '/student-dashboard', primary: true }
      ]
    ));
  }

  const existing = classEnrollments.find(e =>
    Number(e.userId) === Number(user.id) &&
    Number(e.studentKeyId) === Number(keyRecord.id)
  );

  if (!existing) {
    classEnrollments.push({
      id: nextId(classEnrollments),
      userId: user.id,
      studentName: user.name,
      studentEmail: user.email,
      teacherId: keyRecord.teacherId,
      studentKeyId: keyRecord.id,
      key: keyRecord.key,
      className: keyRecord.className,
      testId: keyRecord.testId,
      testTitle: keyRecord.testTitle,
      joinedAt: new Date().toISOString()
    });

    keyRecord.usageCount = Number(keyRecord.usageCount || 0) + 1;
    saveDB();

    await sendEmail(
      user.email,
      `Joined ${keyRecord.className}`,
      `<p>Hello ${escapeHtml(user.name)}, you joined <strong>${escapeHtml(keyRecord.className)}</strong>.</p><p>Your assigned test is: <strong>${escapeHtml(test.title)}</strong>.</p>`
    );
  }

  res.send(makeConfirmationPage(
    'Class Joined',
    `You are now enrolled in <strong>${escapeHtml(keyRecord.className)}</strong>. Your assigned assessment is <strong>${escapeHtml(test.title)}</strong>.`,
    [
      { label: 'Start Assessment', href: `/take-test/${test.id}`, primary: true },
      { label: 'Back to Dashboard', href: '/student-dashboard', primary: false }
    ]
  ));
});

// Optional JSON route so teacher/admin can inspect generated keys.
app.get('/api/student-keys', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const visibleKeys = isAdminUser(user)
    ? studentKeys
    : studentKeys.filter(k => Number(k.teacherId) === Number(user.id));

  res.json({
    ok: true,
    keys: visibleKeys
  });
});

// ==================== TAKE TEST ====================
app.get('/take-test/:id', requireStudent, (req, res) => {
  const user = currentUser(req);
  const test = tests.find(t => Number(t.id) === Number(req.params.id));

  if (!test) return res.redirect('/student-dashboard');

  if (!studentHasAccessToTest(user.id, test)) {
    return res.status(403).send(makeConfirmationPage(
      'Access Key Required',
      'This assessment is locked to a class key. Paste your student access key from your teacher in the Student Dashboard first.',
      [
        { label: 'Back to Student Dashboard', href: '/student-dashboard', primary: true }
      ]
    ));
  }

  if (!test.isOpen) {
    const now = new Date().getTime();

    if (test.examStartTime && now < new Date(test.examStartTime).getTime()) {
      return res.status(403).send(makeConfirmationPage(
        'Exam Not Started',
        'Please return to your dashboard and wait for the start time.',
        [
          { label: 'Back to Student Dashboard', href: '/student-dashboard', primary: true }
        ]
      ));
    }

    if (test.examEndTime && now > new Date(test.examEndTime).getTime()) {
      return res.status(403).send(makeConfirmationPage(
        'Exam Window Closed',
        'The time window for this assessment has passed.',
        [
          { label: 'Back to Student Dashboard', href: '/student-dashboard', primary: true }
        ]
      ));
    }
  }

  req.session.examInProgress = true;
  req.session.currentTestId = test.id;
  req.session.examStartTime = Date.now();

  res.render('take-test', {
    user,
    test
  });
});

// ==================== SUBMIT TEST ====================
app.post('/submit-test/:id', requireStudent, async (req, res) => {
  const user = currentUser(req);

  const testId = parseInt(req.params.id);
  const test = tests.find(t => Number(t.id) === Number(testId));

  if (!test) return res.redirect('/student-dashboard');

  if (!studentHasAccessToTest(user.id, test)) {
    return res.status(403).send('You do not have access to this assessment.');
  }

  const score = parseInt(req.body.score) || 85;
  const passed = score >= 70;

  submissions.push({
    id: nextId(submissions),
    testId,
    userId: user.id,
    studentName: user.name,
    score,
    passed,
    submittedAt: new Date().toISOString()
  });

  if (passed && test.attachedCredentialTemplateId) {
    const template = credentialTemplates.find(t =>
      Number(t.templateId) === Number(test.attachedCredentialTemplateId)
    );

    const alreadyIssued = issuedCredentials.find(c =>
      Number(c.userId) === Number(user.id) &&
      Number(c.testId) === Number(testId) &&
      Number(c.templateId) === Number(test.attachedCredentialTemplateId)
    );

    if (template && !alreadyIssued) {
      const issuedId = nextId(issuedCredentials, 'issuedId');
      const verifyHash = generateCredentialHash(user.id, testId);
      const verifyRoute = `/verify/${verifyHash}`;
      const shareLink = absoluteUrl(req, verifyRoute);
      const qrCode = await generateQR(shareLink);

      const newCred = {
        ...template,
        id: issuedId,
        issuedId,
        badgeId: verifyHash,
        verifyHash,
        shareLink,
        qrCode,
        testId,
        testTitle: test.title,
        userId: user.id,
        studentName: user.name,
        studentEmail: user.email,
        issueDate: new Date().toLocaleDateString(),
        issuedDate: new Date().toLocaleDateString(),
        status: 'passed',
        score,
        submittedAt: new Date().toISOString()
      };

      issuedCredentials.push(newCred);

      await sendEmail(user.email, `Your Results - ${test.title}`, `
        <h2>Congratulations ${escapeHtml(user.name)}!</h2>
        <p>You scored <strong>${score}%</strong> on "${escapeHtml(test.title)}".</p>
        <p>Your credential is ready: <a href="${shareLink}">${shareLink}</a></p>
      `);
    }
  }

  if (test.networkLoggingEnabled) {
    networkLogs.push({
      id: nextId(networkLogs),
      testId,
      userId: user.id,
      studentName: user.name,
      timestamp: new Date().toISOString(),
      userAgent: req.headers['user-agent'],
      ip: req.ip
    });
  }

  req.session.examInProgress = false;
  req.session.currentTestId = null;

  saveDB();

  res.redirect('/student-dashboard');
});

// ==================== VERIFICATION & LOGS ====================
app.get('/verify/:hash', (req, res) => {
  const cred = issuedCredentials.find(c =>
    c.verifyHash === req.params.hash ||
    c.badgeId === req.params.hash
  );

  res.render('verify', {
    credential: cred,
    status: cred ? 'valid' : 'invalid'
  });
});

app.get('/network-logs/:testId', requireTeacher, (req, res) => {
  const user = currentUser(req);
  const test = tests.find(t => Number(t.id) === Number(req.params.testId));

  if (!test) {
    return res.status(404).json({ error: 'Test not found.' });
  }

  if (!isAdminUser(user) && Number(test.teacherId) !== Number(user.id)) {
    return res.status(403).json({ error: 'Unauthorized access to these logs.' });
  }

  const logs = networkLogs.filter(l => Number(l.testId) === Number(req.params.testId));
  res.json(logs);
});

// ==================== BASIC API HEALTH ====================
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'Credity',
    users: users.length,
    badges: credentialTemplates.length,
    issuedCredentials: issuedCredentials.length,
    tests: tests.length,
    studentKeys: studentKeys.length,
    enrollments: classEnrollments.length
  });
});

// ==================== SERVER START ====================
app.listen(PORT, () => {
  console.log(`🚀 Credity running on port ${PORT}`);
});