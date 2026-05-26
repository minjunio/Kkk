const express = require('express');
const path = require('path');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.render('index', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (username === 'admin' && password === 'monterysasd') {
    res.redirect(`/wallet?username=${encodeURIComponent(username)}`);
  } else {
    res.render('index', { error: 'Invalid username or password' });
  }
});

app.get('/wallet', (req, res) => {
  res.render('wallet', {
    username: req.query.username || 'minjunio'
  });
});

app.get('/api/prices', async (req, res) => {
  try {
    const ids = req.query.ids;

    if (!ids) {
      return res.status(400).json({ error: 'Missing ids query parameter' });
    }

    const url =
      `https://api.coingecko.com/api/v3/simple/price` +
      `?ids=${encodeURIComponent(ids)}` +
      `&vs_currencies=usd` +
      `&include_24hr_change=true`;

    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'BlueCrypto-Wallet/1.0'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Price provider failed'
      });
    }

    const data = await response.json();

    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: 'Unable to fetch prices'
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`BlueCrypto running on port ${PORT}`);
});