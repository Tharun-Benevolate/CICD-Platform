require("dotenv").config();
const { pool } = require("../config/db");
const { hashPassword } = require("../middleware/auth");

async function seedAdminAndDeveloper() {
  try {
    const adminHash = hashPassword("admin123");
    await pool.query(
      `INSERT INTO users (username, password_hash, user_type, is_profile_completed)
       VALUES ('admin', ?, 'super_admin', 1)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), user_type = 'super_admin', is_profile_completed = 1`,
      [adminHash]
    );
    console.log("✔ Admin user created/updated (username: 'admin', password: 'admin123', role: 'super_admin')");

    const devHash = hashPassword("developer123");
    await pool.query(
      `INSERT INTO users (username, password_hash, user_type, is_profile_completed)
       VALUES ('developer', ?, 'developer', 1)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), user_type = 'developer', is_profile_completed = 1`,
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
