require("dotenv").config();
const { pool } = require("../config/db");
const tf = require("../services/terraformRunner");

async function getFoundationState() {
  try {
    const outputs = await tf.readFoundationOutputs();
    if (outputs && outputs.vpc_id) {
      return { applied: true, outputs };
    }
    return { applied: false, outputs: null };
  } catch (err) {
    return { applied: false, outputs: null };
  }
}

module.exports = { getFoundationState };
