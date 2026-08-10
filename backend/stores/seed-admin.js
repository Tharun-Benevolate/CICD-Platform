require("dotenv").config();
const { pool } = require("./config/db");
const { hashPassword } = require("./middleware/auth");

async function seedAdminAndDeveloper() {
  try {
    const adminHash = hashPassword("admin123");
    await pool.query(
      `INSERT INTO users (username, password_hash, user_type)
       VALUES ('admin', ?, 'super_admin')
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), user_type = 'super_admin'`,
      [adminHash]
    );
    console.log("✔ Admin user created/updated (username: 'admin', password: 'admin123', role: 'super_admin')");

    const devHash = hashPassword("developer123");
    await pool.query(
      `INSERT INTO users (username, password_hash, user_type)
       VALUES ('developer', ?, 'developer')
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), user_type = 'developer'`,
      [devHash]
    );
    console.log("✔ Developer user created/updated (username: 'developer', password: 'developer123', role: 'developer')");
  } catch (err) {
    console.error("Failed to seed users:", err.message);
  } finally {
    process.exit(0);
  }
}

seedAdminAndDeveloper();
