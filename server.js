const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname));

// DATABASE (In-Memory)
const users = {};
const withdrawalRequests = [];
let totalAdminCommission = 0;

const razorpay = new Razorpay({
  key_id: 'rzp_test_TjBM0y3EF3rCh5',
  key_secret: 'D3351f0JGjhVYJP5ynIjqsfp'
});

// 1. AUTHENTICATION (Login / Register)
app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ success: false, message: 'Phone & Password required!' });
  }

  if (!users[phone]) {
    users[phone] = { phone, password, wallet: 0, isKycVerified: false, totalBet: 0, totalWon: 0 };
  } else if (users[phone].password !== password) {
    return res.status(400).json({ success: false, message: 'Invalid password!' });
  }

  res.json({ success: true, user: users[phone] });
});

// 2. KYC API
app.post('/api/user/kyc', (req, res) => {
  const { phone, panNumber } = req.body;
  if (!users[phone]) return res.status(400).json({ success: false, message: 'User not found' });
  if (!panNumber || panNumber.length !== 10) {
    return res.status(400).json({ success: false, message: 'Invalid 10-digit PAN' });
  }
  users[phone].isKycVerified = true;
  res.json({ success: true, message: 'KYC Verified successfully!' });
});

// 3. PAYMENT DEPOSIT (Razorpay)
app.post('/api/payment/create-order', async (req, res) => {
  const { amount } = req.body;
  try {
    const order = await razorpay.orders.create({
      amount: Number(amount) * 100,
      currency: 'INR',
      receipt: `rec_${Date.now()}`
    });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/payment/verify', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, phone, amount } = req.body;
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSig = crypto.createHmac('sha256', 'D3351f0JGjhVYJP5ynIjqsfp').update(body).digest('hex');

  if (expectedSig === razorpay_signature) {
    if (users[phone]) users[phone].wallet += Number(amount);
    res.json({ success: true, newBalance: users[phone].wallet });
  } else {
    res.status(400).json({ success: false, message: 'Payment verification failed' });
  }
});

// 4. WITHDRAWAL REQUEST
app.post('/api/payment/withdraw', (req, res) => {
  const { phone, amount, upiId } = req.body;
  const amt = Number(amount);

  if (!users[phone]) return res.status(400).json({ success: false, message: 'Invalid Session' });
  if (!users[phone].isKycVerified) {
    return res.status(400).json({ success: false, message: 'Complete KYC first!' });
  }
  if (!amt || amt < 100 || users[phone].wallet < amt) {
    return res.status(400).json({ success: false, message: 'Minimum withdrawal is ₹100 or Insufficient Balance' });
  }

  users[phone].wallet -= amt;
  withdrawalRequests.push({
    id: Date.now(),
    phone,
    amount: amt,
    upiId,
    status: 'PENDING',
    date: new Date().toLocaleString()
  });

  res.json({ success: true, message: 'Withdrawal request submitted!', newBalance: users[phone].wallet });
});

// 5. ADMIN PANEL API (To monitor profits and payouts)
app.get('/api/admin/dashboard', (req, res) => {
  res.json({
    totalCommissionEarned: totalAdminCommission,
    totalUsersCount: Object.keys(users).length,
    usersList: users,
    pendingWithdrawals: withdrawalRequests.filter(r => r.status === 'PENDING')
  });
});

// 6. GAME LOGIC WITH SMART SERVER ADJUSTMENT (RNG + RISK CONTROL)
let activeBets = { Red: 0, Green: 0, Blue: 0, Yellow: 0, Purple: 0 };

io.on('connection', (socket) => {
  socket.on('placeBet', (data) => {
    const { phone, selectedColor, betAmount } = data;
    const user = users[phone];
    const bet = Number(betAmount);

    if (bet < 10 || bet > 100) {
      socket.emit('errorMsg', 'Bet limit: ₹10 to ₹100');
      return;
    }

    if (!user || user.wallet < bet) {
      socket.emit('errorMsg', 'INSUFFICIENT_BALANCE');
      return;
    }

    user.wallet -= bet;
    user.totalBet += bet;
    activeBets[selectedColor] += bet;
    socket.emit('walletUpdated', { newBalance: user.wallet });

    const colors = ['Red', 'Green', 'Blue', 'Yellow', 'Purple'];

    setTimeout(() => {
      // SMART LOGIC: 80% chances of picking the color with LOWEST BET AMOUNT to ensure House Profit
      let winningColor;
      const sortedColors = [...colors].sort((a, b) => activeBets[a] - activeBets[b]);
      
      if (Math.random() < 0.8) {
        winningColor = sortedColors[0]; // Color with minimum bets
      } else {
        winningColor = colors[Math.floor(Math.random() * colors.length)]; // Pure RNG
      }

      const winningIndex = colors.indexOf(winningColor);
      const isWin = selectedColor === winningColor;

      if (isWin) {
        const grossPayout = bet * 2;
        const commission = grossPayout * 0.05; // 5% Cut
        const netPayout = grossPayout - commission;

        totalAdminCommission += commission;
        user.wallet += netPayout;
        user.totalWon += netPayout;
      }

      // Reset active bet tracker
      activeBets[selectedColor] = Math.max(0, activeBets[selectedColor] - bet);

      socket.emit('spinResult', {
        winningIndex,
        winningColor,
        isWin,
        newBalance: user.wallet
      });
    }, 4000);
  });
});

server.listen(3000, () => console.log('Game Server running on port 3000'));
