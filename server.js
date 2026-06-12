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

// ==================== DATABASE ====================
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
let classes = [];
let classEnrollments = [];
let submissions = [];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function normalizeAccessKey(key) {
  return String(key || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function migrateOldKeysToClasses(oldKeys) {
  if (!Array.isArray(oldKeys)) return [];

  return oldKeys.map(k => ({
    id: k.id,
    teacherId: k.teacherId,
    teacherName: k.teacherName || '',
    className: k.className || 'Untitled Class',
    key: k.key,
    normalizedKey: k.normalizedKey || normalizeAccessKey(k.key),
    active: k.active !== false,
    assignedTestIds: k.testId ? [Number(k.testId)] : [],
    announcements: Array.isArray(k.announcements) ? k.announcements : [],
    usageCount: Number(k.usageCount || 0),
    createdAt: k.createdAt || new Date().toISOString()
  }));
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
      classes,
      studentKeys: classes,
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
    classes = Array.isArray(db.classes) ? db.classes : migrateOldKeysToClasses(db.studentKeys);
    classEnrollments = Array.isArray(db.classEnrollments) ? db.classEnrollments : [];
    submissions = Array.isArray(db.submissions) ? db.submissions : [];

    classes.forEach(c => {
      if (!Array.isArray(c.assignedTestIds)) c.assignedTestIds = [];
      if (!Array.isArray(c.announcements)) c.announcements = [];
      if (!c.normalizedKey) c.normalizedKey = normalizeAccessKey(c.key);
      c.usageCount = Number(c.usageCount || 0);
    });

    tests.forEach(t => {
      if (!Array.isArray(t.classIds)) t.classIds = [];
    });
  } catch (err) {
    console.error('DB load error:', err.message);
  }
}

loadDB();

// ==================== MAILER ====================
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
  return users.find(u => Number(u.id) === Number(req.session.user.id)) || req.session.user;
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
  return user && (user.email === 'admin' || Number(user.id) === 0);
}

function generateClassKey() {
  let key;
  let normalized;

  do {
    const a = crypto.randomBytes(2).toString('hex').toUpperCase();
    const b = crypto.randomBytes(2).toString('hex').toUpperCase();
    const c = crypto.randomBytes(2).toString('hex').toUpperCase();

    key = `CRED-${a}-${b}-${c}`;
    normalized = normalizeAccessKey(key);
  } while (classes.some(k => k.normalizedKey === normalized));

  return { key, normalized };
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
  const raw = `${userId}-${assessmentId || 'standalone'}-${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 24);
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
  } catch {
    return [];
  }
}

function collectLogoUrls(bodyValue) {
  const list = Array.isArray(bodyValue) ? bodyValue : bodyValue ? [bodyValue] : [];
  return list.map(x => String(x || '').trim()).filter(Boolean).slice(0, 3);
}

function teacherOwnsTest(teacherId, testId) {
  return tests.find(t => Number(t.id) === Number(testId) && Number(t.teacherId) === Number(teacherId));
}

function teacherOwnsClass(teacherId, classId) {
  return classes.find(c => Number(c.id) === Number(classId) && Number(c.teacherId) === Number(teacherId));
}

function teacherOwnsCredential(teacherId, credentialId) {
  return credentialTemplates.find(b =>
    Number(b.id) === Number(credentialId) &&
    Number(b.teacherId) === Number(teacherId)
  );
}

function latestTeacherCredential(teacherId) {
  return [...credentialTemplates]
    .reverse()
    .find(b => Number(b.teacherId) === Number(teacherId));
}

function studentHasAccessToTest(userId, test) {
  if (!test) return false;

  if (!test.requiresKey) return true;

  const studentClassIds = classEnrollments
    .filter(e => Number(e.userId) === Number(userId))
    .map(e => Number(e.classId));

  return classes.some(c =>
    studentClassIds.includes(Number(c.id)) &&
    Array.isArray(c.assignedTestIds) &&
    c.assignedTestIds.map(Number).includes(Number(test.id))
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

function makePage(title, message, buttons = []) {
  const buttonHtml = buttons.map(btn => {
    return `<a href="${escapeHtml(btn.href)}" style="display:inline-block;margin:8px;padding:12px 18px;border-radius:12px;background:${btn.primary ? '#ffffff' : 'rgba(255,255,255,.08)'};color:${btn.primary ? '#09090b' : '#ffffff'};text-decoration:none;font-weight:500;font-size:13px;border:1px solid rgba(255,255,255,.15)">${escapeHtml(btn.label)}</a>`;
  }).join('');

  return `
    <!DOCTYPE html>
    <html>
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
          font-family: Inter, system-ui, sans-serif;
          display: grid;
          place-items: center;
          padding: 24px;
        }
        .card {
          max-width: 650px;
          width: 100%;
          border: 1px solid rgba(255,255,255,.12);
          background: #111113;
          border-radius: 22px;
          padding: 34px;
          box-shadow: 0 20px 70px rgba(0,0,0,.35);
        }
        .eyebrow {
          color: #34d399;
          font-size: 12px;
          letter-spacing: 2px;
          text-transform: uppercase;
          font-weight: 600;
          margin-bottom: 10px;
        }
        h1 {
          margin: 0 0 12px;
          font-size: 32px;
          letter-spacing: -0.04em;
          font-weight: 650;
        }
        p {
          color: rgba(255,255,255,.72);
          line-height: 1.6;
        }
        code {
          display: block;
          margin: 18px 0;
          padding: 18px;
          border-radius: 14px;
          background: #18181b;
          border: 1px solid rgba(255,255,255,.12);
          color: #a7f3d0;
          font-size: 21px;
          font-weight: 650;
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

// ==================== AUTH ====================
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

  if (!user) {
    return res.render('index', { error: 'Invalid credentials.' });
  }

  req.session.user = user;
  res.redirect(user.role === 'teacher' ? '/teacher-dashboard' : '/student-dashboard');
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
  req.session.destroy(() => res.redirect('/'));
});

// ==================== STUDENT DASHBOARD ====================
app.get('/student-dashboard', requireStudent, (req, res) => {
  const user = currentUser(req);

  const userCredentials = issuedCredentials
    .filter(c => Number(c.userId) === Number(user.id))
    .map(mapIssuedCredentialForStudent);

  const enrollments = classEnrollments.filter(e => Number(e.userId) === Number(user.id));
  const enrolledClassIds = enrollments.map(e => Number(e.classId));

  const studentClasses = classes
    .filter(c => enrolledClassIds.includes(Number(c.id)))
    .map(cls => {
      const assignedTestIds = Array.isArray(cls.assignedTestIds)
        ? cls.assignedTestIds.map(Number)
        : [];

      const assignedTests = tests.filter(t => assignedTestIds.includes(Number(t.id)));

      return {
        ...cls,
        assignedTests,
        assignedTaskCount: assignedTests.length,
        announcements: Array.isArray(cls.announcements) ? cls.announcements : []
      };
    });

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

      const classNames = studentClasses
        .filter(cls => {
          const assignedIds = Array.isArray(cls.assignedTestIds)
            ? cls.assignedTestIds.map(Number)
            : [];

          return assignedIds.includes(Number(t.id));
        })
        .map(cls => cls.className);

      return {
        ...t,
        countdown,
        classNames
      };
    });

  const classAnnouncementCards = [];

  studentClasses.forEach(c => {
    if (Array.isArray(c.announcements)) {
      c.announcements.forEach(a => {
        classAnnouncementCards.push({
          id: `class-${c.id}-announcement-${a.id}`,
          title: a.title || `Announcement for ${c.className}`,
          description: a.description || '',
          date: a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '',
          specialBadgeId: a.specialBadgeId || null,
          className: c.className
        });
      });
    }
  });

  res.render('student-dashboard', {
    user,
    badges: userCredentials,
    issuedCredentials: userCredentials,
    events: [...classAnnouncementCards, ...events],
    tests: visibleTests,
    upcomingExams: visibleTests,
    enrollments,
    classes: studentClasses
  });
});

// ==================== TEACHER DASHBOARD ====================
app.get('/teacher-dashboard', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const teacherTests = tests.filter(t => Number(t.teacherId) === Number(user.id));
  const teacherBadges = credentialTemplates.filter(t => Number(t.teacherId) === Number(user.id));
  const teacherEvents = events.filter(e => !e.teacherId || Number(e.teacherId) === Number(user.id));
  const teacherClassesRaw = classes.filter(c => Number(c.teacherId) === Number(user.id));

  const teacherClasses = teacherClassesRaw.map(cls => {
    const assignedTestIds = Array.isArray(cls.assignedTestIds)
      ? cls.assignedTestIds.map(Number)
      : [];

    const assignedTests = teacherTests.filter(t => assignedTestIds.includes(Number(t.id)));

    const classEnrolls = classEnrollments.filter(e =>
      Number(e.classId) === Number(cls.id)
    );

    const students = classEnrolls.map(enrollment => {
      const userRecord = users.find(u => Number(u.id) === Number(enrollment.userId));

      const studentSubmissions = submissions
        .filter(s =>
          Number(s.userId) === Number(enrollment.userId) &&
          assignedTestIds.includes(Number(s.testId))
        )
        .map(s => {
          const test = tests.find(t => Number(t.id) === Number(s.testId));

          return {
            ...s,
            testTitle: s.testTitle || (test ? test.title : 'Assessment'),
            submittedAtFormatted: s.submittedAt
              ? new Date(s.submittedAt).toLocaleString()
              : ''
          };
        });

      const completedTestIds = studentSubmissions.map(s => Number(s.testId));
      const pendingTests = assignedTests.filter(t => !completedTestIds.includes(Number(t.id)));

      const averageScore = studentSubmissions.length
        ? Math.round(studentSubmissions.reduce((sum, s) => sum + Number(s.score || 0), 0) / studentSubmissions.length)
        : null;

      return {
        enrollmentId: enrollment.id,
        userId: enrollment.userId,
        fullName: enrollment.studentName || (userRecord ? userRecord.name : 'Unknown Student'),
        email: enrollment.studentEmail || (userRecord ? userRecord.email : 'No email'),
        joinedAt: enrollment.joinedAt,
        joinedAtFormatted: enrollment.joinedAt
          ? new Date(enrollment.joinedAt).toLocaleString()
          : '',
        submissions: studentSubmissions,
        pendingTests,
        completedCount: studentSubmissions.length,
        pendingCount: pendingTests.length,
        averageScore
      };
    });

    const classResults = submissions
      .filter(s =>
        assignedTestIds.includes(Number(s.testId)) &&
        classEnrolls.some(e => Number(e.userId) === Number(s.userId))
      )
      .map(s => {
        const test = tests.find(t => Number(t.id) === Number(s.testId));
        const enrollment = classEnrolls.find(e => Number(e.userId) === Number(s.userId));
        const userRecord = users.find(u => Number(u.id) === Number(s.userId));

        return {
          ...s,
          studentName: s.studentName || (enrollment ? enrollment.studentName : userRecord ? userRecord.name : 'Unknown Student'),
          studentEmail: s.studentEmail || (enrollment ? enrollment.studentEmail : userRecord ? userRecord.email : 'No email'),
          testTitle: s.testTitle || (test ? test.title : 'Assessment'),
          submittedAtFormatted: s.submittedAt
            ? new Date(s.submittedAt).toLocaleString()
            : ''
        };
      })
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));

    return {
      ...cls,
      assignedTests,
      students,
      results: classResults,
      studentCount: students.length,
      submissionCount: classResults.length
    };
  });

  res.render('teacher-dashboard', {
    user,
    badges: teacherBadges,
    tests: teacherTests,
    events: teacherEvents,
    classes: teacherClasses,
    studentKeys: teacherClasses,
    enrollments: classEnrollments,
    submissions,
    users
  });
});

app.get('/admin', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const visibleTests = isAdminUser(user) ? tests : tests.filter(t => Number(t.teacherId) === Number(user.id));
  const visibleBadges = isAdminUser(user) ? credentialTemplates : credentialTemplates.filter(t => Number(t.teacherId) === Number(user.id));
  const visibleClasses = isAdminUser(user) ? classes : classes.filter(c => Number(c.teacherId) === Number(user.id));

  res.render('admin', {
    user,
    badges: visibleBadges,
    tests: visibleTests,
    issuedBadges: issuedCredentials,
    users,
    classes: visibleClasses,
    studentKeys: visibleClasses,
    classEnrollments,
    events,
    submissions
  });
});

// ==================== CLASSES ====================
app.post('/generate-student-key', requireTeacher, (req, res) => {
  const user = currentUser(req);
  const className = String(req.body.className || '').trim();

  if (!className) {
    return res.status(400).send('Class name is required.');
  }

  const { key, normalized } = generateClassKey();

  const classRecord = {
    id: nextId(classes),
    teacherId: user.id,
    teacherName: user.name,
    className,
    key,
    normalizedKey: normalized,
    active: true,
    assignedTestIds: [],
    announcements: [],
    usageCount: 0,
    createdAt: new Date().toISOString()
  };

  const optionalTestId = req.body.testId ? parseInt(req.body.testId) : null;

  if (optionalTestId) {
    const test = teacherOwnsTest(user.id, optionalTestId);

    if (test) {
      classRecord.assignedTestIds.push(test.id);
      test.requiresKey = true;

      if (!Array.isArray(test.classIds)) test.classIds = [];
      if (!test.classIds.map(Number).includes(Number(classRecord.id))) {
        test.classIds.push(classRecord.id);
      }
    }
  }

  classes.push(classRecord);
  saveDB();

  res.send(makePage(
    'Class Key Generated',
    `Share this key with your students. They will join <strong>${escapeHtml(className)}</strong>. You can assign assessments and announcements to this class later. <code>${escapeHtml(key)}</code>`,
    [
      { label: 'Back to Teacher Dashboard', href: '/teacher-dashboard#classes', primary: true }
    ]
  ));
});

app.post('/join-class', requireStudent, async (req, res) => {
  const user = currentUser(req);
  const inputKey = normalizeAccessKey(req.body.studentKey);

  const classRecord = classes.find(c =>
    c.normalizedKey === inputKey &&
    c.active !== false
  );

  if (!classRecord) {
    return res.status(404).send(makePage(
      'Invalid Class Key',
      'That class key does not exist or is no longer active. Check the key from your teacher and try again.',
      [
        { label: 'Back to Student Dashboard', href: '/student-dashboard', primary: true }
      ]
    ));
  }

  const existing = classEnrollments.find(e =>
    Number(e.userId) === Number(user.id) &&
    Number(e.classId) === Number(classRecord.id)
  );

  if (!existing) {
    classEnrollments.push({
      id: nextId(classEnrollments),
      userId: user.id,
      studentName: user.name,
      studentEmail: user.email,
      teacherId: classRecord.teacherId,
      classId: classRecord.id,
      key: classRecord.key,
      className: classRecord.className,
      joinedAt: new Date().toISOString()
    });

    classRecord.usageCount = Number(classRecord.usageCount || 0) + 1;
    saveDB();

    await sendEmail(
      user.email,
      `Joined ${classRecord.className}`,
      `<p>Hello ${escapeHtml(user.name)}, you joined <strong>${escapeHtml(classRecord.className)}</strong>.</p>`
    );
  }

  res.send(makePage(
    'Class Joined',
    `You are now enrolled in <strong>${escapeHtml(classRecord.className)}</strong>. Any assessments or announcements assigned by your teacher will appear on your dashboard.`,
    [
      { label: 'Back to Dashboard', href: '/student-dashboard#classes', primary: true }
    ]
  ));
});

app.post('/assign-class-test', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const classId = parseInt(req.body.classId);
  const testId = parseInt(req.body.testId);

  const classRecord = teacherOwnsClass(user.id, classId);
  const test = teacherOwnsTest(user.id, testId);

  if (!classRecord || !test) {
    return res.status(403).send('Invalid class or assessment.');
  }

  if (!Array.isArray(classRecord.assignedTestIds)) {
    classRecord.assignedTestIds = [];
  }

  if (!classRecord.assignedTestIds.map(Number).includes(Number(test.id))) {
    classRecord.assignedTestIds.push(test.id);
  }

  test.requiresKey = true;

  if (!Array.isArray(test.classIds)) {
    test.classIds = [];
  }

  if (!test.classIds.map(Number).includes(Number(classRecord.id))) {
    test.classIds.push(classRecord.id);
  }

  saveDB();
  res.redirect('/teacher-dashboard#classes');
});

app.post('/unassign-class-test', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const classId = parseInt(req.body.classId);
  const testId = parseInt(req.body.testId);

  const classRecord = teacherOwnsClass(user.id, classId);

  if (!classRecord) {
    return res.status(403).send('Invalid class.');
  }

  classRecord.assignedTestIds = (classRecord.assignedTestIds || [])
    .filter(id => Number(id) !== Number(testId));

  const test = teacherOwnsTest(user.id, testId);

  if (test && Array.isArray(test.classIds)) {
    test.classIds = test.classIds.filter(id => Number(id) !== Number(classId));
  }

  const stillAssignedSomewhere = classes.some(c =>
    Array.isArray(c.assignedTestIds) &&
    c.assignedTestIds.map(Number).includes(Number(testId))
  );

  if (test && !stillAssignedSomewhere) {
    test.requiresKey = false;
  }

  saveDB();
  res.redirect('/teacher-dashboard#classes');
});

app.post('/class-announcement', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const classId = parseInt(req.body.classId);
  const classRecord = teacherOwnsClass(user.id, classId);

  if (!classRecord) {
    return res.status(403).send('Invalid class.');
  }

  if (!Array.isArray(classRecord.announcements)) {
    classRecord.announcements = [];
  }

  classRecord.announcements.push({
    id: nextId(classRecord.announcements),
    title: req.body.title || 'Class Announcement',
    description: req.body.description || '',
    specialBadgeId: req.body.specialBadgeId ? parseInt(req.body.specialBadgeId) : null,
    createdBy: user.name,
    createdAt: new Date().toISOString()
  });

  saveDB();
  res.redirect('/teacher-dashboard#classes');
});

app.get('/api/student-keys', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const visibleClasses = isAdminUser(user)
    ? classes
    : classes.filter(c => Number(c.teacherId) === Number(user.id));

  res.json({
    ok: true,
    classes: visibleClasses,
    keys: visibleClasses
  });
});

// ==================== CREDENTIALS ====================
function createCredentialTemplate(req, res) {
  const user = currentUser(req);

  const assessmentId = req.body.assessmentId
    ? parseInt(req.body.assessmentId)
    : null;

  if (assessmentId && !teacherOwnsTest(user.id, assessmentId)) {
    return res.status(403).send('You can only link credentials to your own assessments.');
  }

  const templateId = nextId(credentialTemplates, 'templateId');
  const logos = collectLogoUrls(req.body.logoUrl);

  const newTemplate = {
    id: templateId,
    templateId,
    teacherId: user.id,
    type: req.body.type || 'badge',
    assessmentId,
    title: req.body.title || 'Skill Credential',
    designColor: req.body.designColor || '#2563eb',
    description: req.body.description || '',
    signature: req.body.signature || user.name,
    badgeIcon: req.body.badgeIcon || '',
    badgeShape: req.body.badgeShape || '',
    templateStyle: req.body.templateStyle || '',
    logos,
    logoUrl: logos[0] || '',
    useQR: true,
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

  const classId = req.body.classId ? parseInt(req.body.classId) : null;

  if (classId) {
    const classRecord = teacherOwnsClass(user.id, classId);

    if (!classRecord) {
      return res.status(403).send('Invalid class.');
    }

    if (!Array.isArray(classRecord.announcements)) {
      classRecord.announcements = [];
    }

    classRecord.announcements.push({
      id: nextId(classRecord.announcements),
      title: req.body.title || 'Class Announcement',
      description: req.body.description || '',
      specialBadgeId: req.body.specialBadgeId ? parseInt(req.body.specialBadgeId) : null,
      createdBy: user.name,
      createdAt: new Date().toISOString()
    });

    saveDB();
    return res.redirect('/teacher-dashboard#classes');
  }

  const specialBadgeId = req.body.specialBadgeId
    ? parseInt(req.body.specialBadgeId)
    : null;

  if (specialBadgeId && !teacherOwnsCredential(user.id, specialBadgeId)) {
    return res.status(403).send('You can only attach your own credentials.');
  }

  events.push({
    id: nextId(events),
    teacherId: user.id,
    title: req.body.title || 'Special Event',
    description: req.body.description || '',
    specialBadgeId,
    date: new Date().toLocaleDateString(),
    createdBy: user.name,
    createdAt: new Date().toISOString()
  });

  saveDB();
  res.redirect(isAdminUser(user) ? '/admin' : '/teacher-dashboard');
});

// ==================== ASSESSMENT CREATION ====================
app.get('/assessment', requireTeacher, (req, res) => {
  const user = currentUser(req);

  const teacherTemplates = credentialTemplates.filter(t => Number(t.teacherId) === Number(user.id));
  const teacherClasses = classes.filter(c => Number(c.teacherId) === Number(user.id));

  res.render('assessment', {
    templates: teacherTemplates,
    classes: teacherClasses,
    user
  });
});

function createTestFromBody(req, res) {
  const user = currentUser(req);
  const questions = parseQuestions(req.body.questions);
  const hasGraphData = questions.some(q => q.graphData !== undefined);

  const requestedTemplateId = req.body.attachedCredentialTemplateId
    ? parseInt(req.body.attachedCredentialTemplateId)
    : null;

  let attachedCredentialTemplateId = null;

  if (requestedTemplateId) {
    const ownedTemplate = credentialTemplates.find(t =>
      Number(t.templateId) === Number(requestedTemplateId) &&
      Number(t.teacherId) === Number(user.id)
    );

    if (ownedTemplate) {
      attachedCredentialTemplateId = ownedTemplate.templateId;
    }
  } else {
    const latest = latestTeacherCredential(user.id);
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
    classIds: [],

    showResultsAfterReview: req.body.showResultsAfterReview === 'true',
    networkLoggingEnabled: true,
    createdBy: user.name,
    dateCreated: new Date().toISOString()
  };

  tests.push(newTest);

  const classId = req.body.classId ? parseInt(req.body.classId) : null;

  if (classId) {
    const classRecord = teacherOwnsClass(user.id, classId);

    if (classRecord) {
      if (!Array.isArray(classRecord.assignedTestIds)) classRecord.assignedTestIds = [];

      if (!classRecord.assignedTestIds.map(Number).includes(Number(newTest.id))) {
        classRecord.assignedTestIds.push(newTest.id);
      }

      newTest.requiresKey = true;
      newTest.classIds = [classRecord.id];
    }
  }

  saveDB();

  res.redirect(isAdminUser(user) ? '/admin' : '/teacher-dashboard');
}

app.post('/assessment', requireTeacher, createTestFromBody);
app.post('/create-test', requireTeacher, createTestFromBody);

// ==================== TAKE TEST ====================
app.get('/take-test/:id', requireStudent, (req, res) => {
  const user = currentUser(req);
  const test = tests.find(t => Number(t.id) === Number(req.params.id));

  if (!test) return res.redirect('/student-dashboard');

  if (!studentHasAccessToTest(user.id, test)) {
    return res.status(403).send(makePage(
      'Class Access Required',
      'This assessment belongs to a class. Join the class using your teacher key first.',
      [
        { label: 'Back to Student Dashboard', href: '/student-dashboard', primary: true }
      ]
    ));
  }

  if (!test.isOpen) {
    const now = new Date().getTime();

    if (test.examStartTime && now < new Date(test.examStartTime).getTime()) {
      return res.status(403).send(makePage(
        'Exam Not Started',
        'Please return to your dashboard and wait for the start time.',
        [
          { label: 'Back to Student Dashboard', href: '/student-dashboard', primary: true }
        ]
      ));
    }

    if (test.examEndTime && now > new Date(test.examEndTime).getTime()) {
      return res.status(403).send(makePage(
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

  res.render('take-test', { user, test });
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

  const studentClassIdsForTest = classes
    .filter(cls => {
      const assignedIds = Array.isArray(cls.assignedTestIds)
        ? cls.assignedTestIds.map(Number)
        : [];

      return assignedIds.includes(Number(testId)) &&
        classEnrollments.some(e =>
          Number(e.classId) === Number(cls.id) &&
          Number(e.userId) === Number(user.id)
        );
    })
    .map(cls => cls.id);

  submissions.push({
    id: nextId(submissions),
    testId,
    testTitle: test.title,
    teacherId: test.teacherId,
    classIds: studentClassIdsForTest,
    userId: user.id,
    studentName: user.name,
    studentEmail: user.email,
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
      const shareLink = absoluteUrl(req, `/verify/${verifyHash}`);
      const qrCode = await generateQR(shareLink);

      issuedCredentials.push({
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
      });

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
  res.redirect('/student-dashboard#tasks');
});

// ==================== VERIFY / LOGS ====================
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

  res.json(networkLogs.filter(l => Number(l.testId) === Number(req.params.testId)));
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'Credity',
    users: users.length,
    credentials: credentialTemplates.length,
    issuedCredentials: issuedCredentials.length,
    tests: tests.length,
    classes: classes.length,
    enrollments: classEnrollments.length,
    submissions: submissions.length
  });
});

// ==================== SERVER START ====================
app.listen(PORT, () => {
  console.log(`🚀 Credity running on port ${PORT}`);
});