import https from 'https';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config({ path: '../userinfo.env' });

const app = express();
const PORT = 5000;

// SSL 憑證
const httpsOptions = {
  key: fs.readFileSync('./certs/key.pem'),
  cert: fs.readFileSync('./certs/cert.pem'),
};

// 資料庫連接設定
const dbConfig = {
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user: 'testuser',
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
  port: 1433,
};

// 連接資料庫
async function connectToDB() {
  try {
    const pool = await sql.connect(dbConfig);
    console.log('資料庫連接成功');
    return pool;
  } catch (err) {
    console.error('資料庫連接失敗:', err.message);
    throw err;
  }
}

// 查詢
async function testQuery() {
  try {
    const pool = await connectToDB();
  } catch (err) {
    console.error('測試查詢失敗:', err.message);
  }
}

app.use(cors());
app.use(express.json());

// 查詢書籍列表和可用副本數量
app.get("/api/books", async (req, res) => {
  try {
    const query = `
      SELECT 
        b.bookID, 
        b.title, 
        b.author, 
        b.publishedYear,
        b.category,
        COUNT(c.copyID) AS availableCopies
      FROM 
        book b
      LEFT JOIN 
        copy c
      ON 
        b.bookID = c.bookID AND c.status = 'available' -- 只計算可用的副本
      GROUP BY 
        b.bookID, b.title, b.author, b.publishedYear, b.category;
    `;

    const result = await sql.query(query);
    res.json(result.recordset); // 返回查詢結果
  } catch (err) {
    console.error("查詢書籍失敗:", err.message);
    res.status(500).send("伺服器錯誤");
  }
});

// Email 格式驗證
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 創建帳號
app.post('/api/SignUp', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: '所有欄位均為必填' });
  }

  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: '無效的 Email 格式' });
  }

  try {
    const pool = await connectToDB();

    // 檢查 userName 和 email 是否已存在
    const checkQuery = `SELECT COUNT(*) AS count FROM member WHERE userName = @Username OR email = @Email`;
    const checkResult = await pool.request()
      .input('Username', sql.VarChar, username)
      .input('Email', sql.VarChar, email)
      .query(checkQuery);

    if (checkResult.recordset[0].count > 0) {
      return res.status(400).json({ error: '用戶名或 Email 已被註冊' });
    }

    // 插入新帳號
    const insertQuery = `
      INSERT INTO member (userName, email, password)
      VALUES (@Username, @Email, @Password)
    `;
    await pool.request()
      .input('Username', sql.VarChar, username)
      .input('Email', sql.VarChar, email)
      .input('Password', sql.VarChar, password)
      .query(insertQuery);

    res.status(201).json({ message: '帳號創建成功' });
  } catch (err) {
    console.error('創建帳號失敗:', err.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// 登入帳號
app.post('/api/SignIn', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '所有欄位均為必填' });
  }

  try {
    const pool = await connectToDB();

    // 驗證 userName 和密碼
    const SignInQuery = `
      SELECT * 
      FROM member 
      WHERE userName = @Username AND password = @Password
    `;
    const SignInResult = await pool.request()
      .input('Username', sql.VarChar, username)
      .input('Password', sql.VarChar, password)
      .query(SignInQuery);

    if (SignInResult.recordset.length === 0) {
      return res.status(400).json({ error: '用戶名或密碼錯誤' });
    }
    const user = SignInResult.recordset[0];
    res.status(200).json({ userID: user.userID, userName: user.userName });
  } catch (err) {
    console.error('登入失敗:', err.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// 檢查用戶借閱書籍數量
app.get('/api/userBooks/:userID', async (req, res) => {
  const { userID } = req.params;

  if (!userID) {
    return res.status(400).json({ error: 'userID 為必填' });
  }

  try {
    const pool = await connectToDB();

    const query = `
      SELECT b.bookID, b.title, b.author, c.copyID, br.borrowDate
      FROM borrowing br
      JOIN copy c ON br.copyID = c.copyID
      JOIN book b ON c.bookID = b.bookID
      WHERE br.userID = @UserID AND br.returnDate IS NULL
    `;
    const result = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(query);

    res.status(200).json(result.recordset);
  } catch (err) {
    console.error('查詢借閱書籍失敗:', err.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});



app.post('/api/borrowBook', async (req, res) => {
  const { userID, bookID } = req.body;

  if (!userID || !bookID) {
    return res.status(400).json({ error: 'userID 和 bookID 均為必填' });
  }

  try {
    const pool = await connectToDB();

    // 檢查用戶是否達到借閱上限
    const countQuery = `
      SELECT COUNT(*) AS borrowedCount
      FROM borrowing
      WHERE userID = @UserID AND returnDate IS NULL
    `;
    const countResult = await pool.request()
      .input('UserID', sql.Int, userID)
      .query(countQuery);

    if (countResult.recordset[0].borrowedCount >= 3) {
      return res.status(400).json({ error: '借閱數量已達上限' });
    }

    // 查找可用的書籍副本
    const checkCopyQuery = `
      SELECT TOP 1 copyID
      FROM copy
      WHERE bookID = @BookID AND status = 'available'
    `;
    const copyResult = await pool.request()
      .input('BookID', sql.Int, bookID)
      .query(checkCopyQuery);

    if (copyResult.recordset.length === 0) {
      return res.status(400).json({ error: '該書已無可借閱副本' });
    }

    const copyID = copyResult.recordset[0].copyID;

    // 插入借閱記錄並更新副本狀態
    const borrowQuery = `
      INSERT INTO borrowing (userID, copyID, borrowDate, dueDate, status)
      VALUES (@UserID, @CopyID, GETDATE(), DATEADD(DAY, 14, GETDATE()), 'borrowed');

      UPDATE copy
      SET status = 'unavailable'
      WHERE copyID = @CopyID;
    `;
    const transaction = pool.transaction();

    try {
      await transaction.begin();

      await transaction.request()
        .input('UserID', sql.Int, userID)
        .input('CopyID', sql.Int, copyID)
        .query(borrowQuery);

      await transaction.commit();

      res.status(200).json({ message: '借閱成功', copyID });
    } catch (err) {
      await transaction.rollback();
      console.error('借閱失敗:', err.message);
      res.status(500).json({ error: '伺服器錯誤' });
    }
  } catch (err) {
    console.error('借閱失敗:', err.message);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});


// 啟動伺服器
https.createServer(httpsOptions, app).listen(PORT, () => {
  console.log(`Server is running on https://localhost:${PORT}`);
  testQuery();
});


