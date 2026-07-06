require("dotenv").config();
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const TOKEN = process.env.CHECKER_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_PV_ID = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;
const BOT_NAME = "fairy-checker";
const CHECK_INTERVAL_MS = 60_000;
const HEARTBEAT_FILE = path.join(__dirname, ".bot-heartbeat");
const STALE_THRESHOLD_MS = 5 * 60_000;

let lastAlert = 0;
const ALERT_COOLDOWN_MS = 10 * 60_000;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[watchdog ${ts}] ${msg}`);
  try {
    fs.appendFileSync(path.join(__dirname, "watchdog.log"), `[${ts}] ${msg}\n`);
  } catch {}
}

function sendTelegram(text) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ chat_id: ADMIN_PV_ID, text, parse_mode: "Markdown", disable_notification: true });
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => { res.on("data", () => {}); res.on("end", () => resolve(true)); });
    req.on("error", () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

async function alert(msg) {
  const now = Date.now();
  if (now - lastAlert < ALERT_COOLDOWN_MS) return;
  lastAlert = now;
  if (ADMIN_PV_ID) {
    await sendTelegram(`*WATCHDOG ALERTA*\n\n${msg}\n\n_${new Date().toLocaleString("pt-BR")}_`);
  }
  log(`ALERTA ENVIADO: ${msg}`);
}

function run(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: e.message };
  }
}

function checkPm2Daemon() {
  const res = run("pm2 ping");
  return res.ok;
}

function checkBotProcess() {
  const res = run(`pm2 jlist`);
  if (!res.ok) return { running: false, info: null };
  try {
    const list = JSON.parse(res.out);
    const proc = list.find((p) => p.name === BOT_NAME);
    if (!proc) return { running: false, info: null };
    const running = proc.pm2_env?.status === "online";
    return { running, info: proc, restarts: proc.pm2_env?.restart_time || 0 };
  } catch {
    return { running: false, info: null };
  }
}

function checkBotResponsive() {
  if (!TOKEN) return false;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TOKEN}/getMe`,
      method: "GET",
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          resolve(j.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function writeHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString());
  } catch {}
}

function readLastHeartbeat() {
  try {
    if (!fs.existsSync(HEARTBEAT_FILE)) return null;
    return new Date(fs.readFileSync(HEARTBEAT_FILE, "utf-8")).getTime();
  } catch {
    return null;
  }
}

async function tick() {
  log("verificando...");

  if (!checkPm2Daemon()) {
    log("pm2 daemon morto. Reiniciando...");
    run("pm2 resurrect");
    await new Promise((r) => setTimeout(r, 5000));
    if (!checkPm2Daemon()) {
      log("Falha ao acordar pm2. Tentando start fresh...");
      run(`pm2 start "${path.join(__dirname, "checker-bot.js")}" --name ${BOT_NAME} --max-memory-restart 200M --restart-delay 5000`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const proc = checkBotProcess();
  if (!proc.running) {
    log(`processo ${BOT_NAME} nao esta online. Reiniciando...`);
    run(`pm2 start "${path.join(__dirname, "checker-bot.js")}" --name ${BOT_NAME} --max-memory-restart 200M --restart-delay 5000`);
    await new Promise((r) => setTimeout(r, 5000));
    await alert(`Processo ${BOT_NAME} estava down. Reiniciado automaticamente.`);
  } else if (proc.restarts > 10) {
    log(`muitos restarts (${proc.restarts}). Investigando...`);
    await alert(`Bot reiniciou ${proc.restarts} vezes. Pode ter loop de crash.`);
  }

  const responsive = await checkBotResponsive();
  if (!responsive) {
    log("bot nao responde a API do Telegram. Reiniciando...");
    run(`pm2 restart ${BOT_NAME}`);
    await new Promise((r) => setTimeout(r, 5000));
    await alert("Bot nao respondia a API do Telegram. Reiniciado.");
  }

  writeHeartbeat();
  log("OK - tudo certo.");
}

async function main() {
  log("watchdog iniciado.");
  writeHeartbeat();

  if (ADMIN_PV_ID) {
    await sendTelegram("*Watchdog ATIVO*\n\nMonitorando bot a cada 60s. Voce so recebe msg se algo cair.");
  }

  while (true) {
    try {
      await tick();
    } catch (e) {
      log(`erro no tick: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

process.on("SIGINT", () => { log("encerrando"); process.exit(0); });
process.on("SIGTERM", () => { log("encerrando"); process.exit(0); });

main();
