require("dotenv").config();
const { Telegraf } = require("telegraf");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const http = require("http");
const OpenAI = require("openai");

const TOKEN = process.env.CHECKER_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const CHECKER_GROUP_ID = process.env.CHECKER_GROUP_ID ? Number(process.env.CHECKER_GROUP_ID) : null;
const ADMIN_PV_ID = process.env.ADMIN_PV_ID ? Number(process.env.ADMIN_PV_ID) : null;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;
const PINAR = process.env.CHECKER_PIN !== "false";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";
const PORT = process.env.PORT || 3000;
const USE_WEBHOOK = process.env.USE_WEBHOOK !== "false";
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!TOKEN) {
  console.error("Falta CHECKER_BOT_TOKEN no .env");
  process.exit(1);
}

if (!CHECKER_GROUP_ID) {
  console.warn("CHECKER_GROUP_ID nao configurado. Mande /id no grupo para descobrir.");
}

const bot = new Telegraf(TOKEN);
const ai = OPENROUTER_KEY ? new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: OPENROUTER_KEY }) : null;

const STATE_FILE = path.join(__dirname, "checker-state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch (e) {
    console.error("Erro lendo checker-state.json:", e.message);
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

function somarDiasISO(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function fmtData(iso) {
  if (!iso) return "—";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

function dataBR() {
  const d = new Date();
  return d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
}

function grupoDaTarefa(state, pessoa, tarefaKey) {
  if (state.pessoas[pessoa].tarefas_semanais && state.pessoas[pessoa].tarefas_semanais[tarefaKey]) {
    return "tarefas_semanais";
  }
  return "tarefas_diarias";
}

function coberto(task) {
  if (!task.coberto_ate) return false;
  return task.coberto_ate >= hojeISO();
}

async function interpretarResposta(texto) {
  if (!ai) {
    const t = texto.toLowerCase();
    const m = t.match(/(\d+)\s*dias?/);
    if (m) return { resposta: "sim", dias_cobertos: parseInt(m[1]), observacao: texto, confianca: "baixa" };
    if (t.includes("semana") || t.includes("semana todinha")) return { resposta: "sim", dias_cobertos: 7, observacao: texto, confianca: "baixa" };
    if (t.match(/\b(sim|feito|pronto|ok|✅|postei|agendei|ja)\b/)) return { resposta: "sim", dias_cobertos: 1, observacao: texto, confianca: "baixa" };
    return { resposta: "nao", dias_cobertos: 0, observacao: texto, confianca: "baixa" };
  }

  const prompt = `Voce eh um assistente que interpreta respostas de uma equipe de redes sociais em portugues brasileiro.
A pessoa recebeu uma pergunta sobre uma tarefa e respondeu de forma natural.

Resposta: "${texto}"

Extraia em JSON puro (sem markdown, sem texto extra) os campos:
- resposta: "sim" se a tarefa foi feita/coberta, "nao" se nao foi feita, "parcial" se fez so parte
- dias_cobertos: numero inteiro de dias que a pessoa diz que ja esta coberto (0 se nao falou, 1 se disse "sim" sem prazo, 7 se disse "semana", etc)
- observacao: resumo curto em 1 frase do que a pessoa disse
- confianca: "alta" se voce tem certeza, "baixa" se foi ambiguo

Exemplos:
- "ja postei pra semana todinha" -> {"resposta":"sim","dias_cobertos":7,"observacao":"cobriu a semana inteira","confianca":"alta"}
- "fiz pra 3 dias seguidos" -> {"resposta":"sim","dias_cobertos":3,"observacao":"cobriu 3 dias","confianca":"alta"}
- "ainda nao" -> {"resposta":"nao","dias_cobertos":0,"observacao":"nao fez","confianca":"alta"}
- "feito" -> {"resposta":"sim","dias_cobertos":1,"observacao":"fez hoje","confianca":"alta"}
- "fiz o da Elza mas falta Melyssa" -> {"resposta":"parcial","dias_cobertos":0,"observacao":"so fez uma modelo","confianca":"alta"}

Responda APENAS o JSON.`;

  try {
    const res = await ai.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });
    const content = (res.choices[0]?.message?.content || "").trim().replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(content);
  } catch (e) {
    console.error("Erro IA interpretando resposta:", e.message);
    const t = texto.toLowerCase();
    if (t.match(/\b(sim|feito|pronto|ok|✅|postei|agendei|ja)\b/)) {
      return { resposta: "sim", dias_cobertos: 1, observacao: texto, confianca: "fallback" };
    }
    return { resposta: "nao", dias_cobertos: 0, observacao: texto, confianca: "fallback" };
  }
}

async function pinar(messageId) {
  if (!PINAR) return;
  try {
    await bot.telegram.pinChatMessage(CHECKER_GROUP_ID, messageId, { disable_notification: true });
  } catch (e) {
    console.warn("Nao foi possivel pinar mensagem:", e.message);
  }
}

async function desfixar(messageId) {
  try {
    await bot.telegram.unpinChatMessage(CHECKER_GROUP_ID, messageId);
  } catch (e) {}
}

async function perguntar(pessoa, tarefaKey) {
  const state = loadState();
  if (!state) return;

  const grupo = grupoDaTarefa(state, pessoa, tarefaKey);
  const tarefa = state.pessoas[pessoa][grupo][tarefaKey];
  if (coberto(tarefa)) {
    console.log(`[${pessoa}/${tarefaKey}] Coberto ate ${tarefa.coberto_ate}. Pulando.`);
    return;
  }

  const username = state.pessoas[pessoa].username_telegram || pessoa;
  const texto = `*Checagem ${dataBR()}*\n\n${username} ja ${tarefa.label}?\n\nResponda com qualquer frase (a IA entende coisas como "ja postei pra 3 dias" ou "semana todinha").`;

  try {
    const msg = await bot.telegram.sendMessage(CHECKER_GROUP_ID, texto, { parse_mode: "Markdown" });
    await pinar(msg.message_id);

    tarefa.ultimo_check = hojeISO();
    state.historico_mensagens.push({
      message_id: msg.message_id,
      pessoa,
      tarefa: tarefaKey,
      grupo,
      texto: msg.text,
      enviada_em: new Date().toISOString(),
      respondida: false,
    });
    if (state.historico_mensagens.length > 200) state.historico_mensagens = state.historico_mensagens.slice(-100);
    saveState(state);
    console.log(`[${pessoa}/${tarefaKey}] Pergunta enviada.`);
  } catch (e) {
    console.error(`Erro enviando pergunta ${pessoa}/${tarefaKey}:`, e.message);
  }
}

async function checarTarefasDiarias() {
  const state = loadState();
  if (!state) return;
  for (const [pessoa, dados] of Object.entries(state.pessoas)) {
    if (!dados.tarefas_diarias) continue;
    for (const key of Object.keys(dados.tarefas_diarias)) {
      await perguntar(pessoa, key);
    }
  }
}

async function checarTarefasSemanais() {
  const state = loadState();
  if (!state) return;
  for (const [pessoa, dados] of Object.entries(state.pessoas)) {
    if (!dados.tarefas_semanais) continue;
    for (const key of Object.keys(dados.tarefas_semanais)) {
      await perguntar(pessoa, key);
    }
  }
}

async function cobrarContabilidade() {
  const state = loadState();
  if (!state) return;
  const t = state.tarefas_mensais.contabilidade;
  if (!t) return;

  const hoje = new Date();
  const mes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  if (t.ultimo_pagamento === mes) return;

  const diasRestantes = t.prazo_dia - hoje.getDate();
  const avisoPrazo = diasRestantes > 0 ? `faltam ${diasRestantes} dias` : `prazo era dia ${t.prazo_dia}`;

  const texto = `*Lembrete mensal - ${dataBR()}*\n\n${t.responsavel}, ${avisoPrazo} para o prazo.\n\nTarefa: ${t.label}\n\nMe avise no PV do gestor quando enviar.`;

  try {
    if (ADMIN_PV_ID) {
      await bot.telegram.sendMessage(ADMIN_PV_ID, texto, { parse_mode: "Markdown" });
    } else if (CHECKER_GROUP_ID) {
      await bot.telegram.sendMessage(CHECKER_GROUP_ID, texto, { parse_mode: "Markdown" });
    }
    t.ultimo_check_mes = hojeISO();
    saveState(state);
    console.log("Cobranca de contabilidade enviada.");
  } catch (e) {
    console.error("Erro contabilidade:", e.message);
  }
}

function encontrarTarefaPorMessageId(state, messageId) {
  for (const reg of state.historico_mensagens) {
    if (reg.message_id === messageId && !reg.respondida) return reg;
  }
  return null;
}

bot.on("message", async (ctx) => {
  if (!CHECKER_GROUP_ID) return;
  if (ctx.chat.id !== CHECKER_GROUP_ID) return;
  if (ctx.message?.from?.is_bot) return;
  if (!ctx.message?.reply_to_message) return;

  const replyId = ctx.message.reply_to_message.message_id;
  const state = loadState();
  if (!state) return;

  const reg = encontrarTarefaPorMessageId(state, replyId);
  if (!reg) return;

  const texto = ctx.message.text || "";
  if (!texto) {
    return ctx.reply("Responda em texto, por favor. A IA leu sua msg e nao entendeu.");
  }

  console.log(`[checker] Resposta de ${ctx.message.from.username || ctx.message.from.id} para msg ${replyId}: ${texto}`);

  const interpretacao = await interpretarResposta(texto);
  const tarefa = state.pessoas[reg.pessoa][reg.grupo][reg.tarefa];

  if (interpretacao.resposta === "sim") {
    if (interpretacao.dias_cobertos > 0) {
      tarefa.coberto_ate = somarDiasISO(interpretacao.dias_cobertos - 1);
    } else {
      tarefa.coberto_ate = hojeISO();
    }
  } else if (interpretacao.resposta === "parcial") {
    tarefa.coberto_ate = null;
  } else {
    tarefa.coberto_ate = null;
  }

  tarefa.ultimo_status = interpretacao.observacao || texto;
  reg.respondida = true;
  reg.resposta = texto;
  reg.interpretacao = interpretacao;
  reg.respondida_em = new Date().toISOString();
  saveState(state);

  let confirmacao = "";
  if (interpretacao.resposta === "sim" && interpretacao.dias_cobertos > 1) {
    confirmacao = `Entendido. Cobrirei *${interpretacao.dias_cobertos} dias* (ate ${fmtData(tarefa.coberto_ate)}). Nao vou te incomodar sobre isso ate la.`;
  } else if (interpretacao.resposta === "sim") {
    confirmacao = `Anotado. Amanha eu cobro de novo.`;
  } else if (interpretacao.resposta === "parcial") {
    confirmacao = `Parcial anotado: ${interpretacao.observacao}. Vou cobrar de novo amanha.`;
  } else {
    confirmacao = `Anotado que ainda nao foi feito. Vou cobrar de novo amanha.`;
  }

  await ctx.reply(confirmacao, { parse_mode: "Markdown" });
  try { await desfixar(replyId); } catch {}
});

bot.command("id", (ctx) => {
  ctx.reply(`Chat ID: \`${ctx.chat.id}\``, { parse_mode: "MarkdownV2" });
});

bot.command("status", async (ctx) => {
  const state = loadState();
  if (!state) return ctx.reply("Estado indisponivel.");

  const linhas = [`*Status de cobertura - ${dataBR()}*\n`];
  for (const [pessoa, dados] of Object.entries(state.pessoas)) {
    linhas.push(`*${pessoa}* (${dados.username_telegram || "—"})`);
    if (dados.tarefas_diarias) {
      for (const [key, t] of Object.entries(dados.tarefas_diarias)) {
        const status = coberto(t) ? `coberto ate ${fmtData(t.coberto_ate)}` : "em aberto";
        linhas.push(`  D  - ${t.label}: ${status}`);
      }
    }
    if (dados.tarefas_semanais) {
      for (const [key, t] of Object.entries(dados.tarefas_semanais)) {
        const status = coberto(t) ? `coberto ate ${fmtData(t.coberto_ate)}` : "em aberto";
        linhas.push(`  S  - ${t.label}: ${status}`);
      }
    }
    linhas.push("");
  }
  await ctx.reply(linhas.join("\n"), { parse_mode: "Markdown" });
});

bot.command("cobertura", async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1);
  if (args.length < 2) return ctx.reply("Use: /cobertura <pessoa> <dias>\nEx: /cobertura Eduarda 5");

  const pessoa = args[0];
  const dias = parseInt(args[1]);
  if (isNaN(dias) || dias < 0) return ctx.reply("Dias invalido (numero >= 0).");

  const state = loadState();
  if (!state) return;
  if (!state.pessoas[pessoa]) return ctx.reply(`Pessoa '${pessoa}' nao existe. Disponiveis: ${Object.keys(state.pessoas).join(", ")}`);

  for (const grupo of ["tarefas_diarias", "tarefas_semanais"]) {
    if (!state.pessoas[pessoa][grupo]) continue;
    for (const t of Object.values(state.pessoas[pessoa][grupo])) {
      t.coberto_ate = dias > 0 ? somarDiasISO(dias - 1) : null;
    }
  }
  saveState(state);
  await ctx.reply(`${pessoa} marcada como coberta por ${dias} dias.`);
});

bot.command("forcar", async (ctx) => {
  await ctx.reply("Forcando checagem de todas as tarefas...");
  await checarTarefasDiarias();
  await checarTarefasSemanais();
  await ctx.reply("Checagens disparadas.");
});

bot.command("tarefas", async (ctx) => {
  const state = loadState();
  if (!state) return;
  const linhas = ["*Tarefas configuradas:*\n"];
  for (const [pessoa, dados] of Object.entries(state.pessoas)) {
    if (dados.tarefas_diarias) {
      for (const t of Object.values(dados.tarefas_diarias)) linhas.push(`[DIARIA - ${pessoa}] ${t.label}`);
    }
    if (dados.tarefas_semanais) {
      for (const t of Object.values(dados.tarefas_semanais)) linhas.push(`[SEMANAL - ${pessoa}] ${t.label}`);
    }
  }
  if (state.tarefas_mensais?.contabilidade) {
    const cm = state.tarefas_mensais.contabilidade;
    linhas.push(`\n[MENSAL - ${cm.responsavel}] ${cm.label} (ate dia ${cm.prazo_dia})`);
  }
  await ctx.reply(linhas.join("\n"), { parse_mode: "Markdown" });
});

bot.command("reset", async (ctx) => {
  if (ADMIN_TELEGRAM_ID && ctx.from.id !== ADMIN_TELEGRAM_ID) return;
  const state = loadState();
  if (!state) return;
  for (const dados of Object.values(state.pessoas)) {
    for (const grupo of ["tarefas_diarias", "tarefas_semanais"]) {
      if (!dados[grupo]) continue;
      for (const t of Object.values(dados[grupo])) {
        t.coberto_ate = null;
        t.ultimo_status = null;
        t.ultimo_check = null;
      }
    }
  }
  saveState(state);
  await ctx.reply("Todas as coberturas foram resetadas.");
});

bot.command("contabilidade_feita", async (ctx) => {
  if (ADMIN_TELEGRAM_ID && ctx.from.id !== ADMIN_TELEGRAM_ID) return;
  const state = loadState();
  if (!state) return;
  const hoje = new Date();
  const mes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  state.tarefas_mensais.contabilidade.ultimo_pagamento = mes;
  saveState(state);
  await ctx.reply(`Contabilidade de ${mes} marcada como entregue.`);
});

bot.command("teste", async (ctx) => {
  if (ADMIN_TELEGRAM_ID && ctx.from.id !== ADMIN_TELEGRAM_ID) return;
  await ctx.reply("Checker-cloud ativo.\n\nCrons:\n- 08:00, 11:55, 15:55, 19:55: tarefas diarias\n- 09:00 segunda: tarefas semanais (Yan)\n- 09:00 dia 1: contabilidade mensal\n\nComandos: /status, /cobertura, /forcar, /tarefas, /reset, /contabilidade_feita");
});

cron.schedule("0 8 * * *", () => checarTarefasDiarias());
cron.schedule("55 11 * * *", () => checarTarefasDiarias());
cron.schedule("55 15 * * *", () => checarTarefasDiarias());
cron.schedule("55 19 * * *", () => checarTarefasDiarias());
cron.schedule("0 9 * * 1", () => checarTarefasSemanais());
cron.schedule("0 9 1 * *", () => cobrarContabilidade());

const server = http.createServer((req, res) => {
  const ts = new Date().toISOString();

  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "online",
      mode: USE_WEBHOOK ? "webhook" : "polling",
      uptime: process.uptime(),
      timestamp: ts,
    }));
    console.log(`[health] ${ts} GET ${req.url} from ${req.socket.remoteAddress}`);
    return;
  }

  if (req.url === "/ping" || req.url === "/keepalive") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("pong");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`HTTP server na porta ${PORT} (health: http://localhost:${PORT}/health)`);
});

async function setupWebhook() {
  if (!WEBHOOK_URL) {
    console.warn("WEBHOOK_URL nao definido. Usando polling como fallback.");
    return false;
  }
  try {
    const webhookPath = `/telegraf/${TOKEN}`;
    const fullUrl = `${WEBHOOK_URL.replace(/\/$/, "")}${webhookPath}`;
    await bot.telegram.setWebhook(fullUrl);
    console.log(`Webhook configurado: ${fullUrl}`);
    return true;
  } catch (e) {
    console.error("Erro configurando webhook:", e.message);
    return false;
  }
}

async function main() {
  console.log("Checker-cloud iniciando...");
  console.log(`Modo: ${USE_WEBHOOK ? "webhook" : "polling"}`);
  console.log(`Grupo: ${CHECKER_GROUP_ID}`);
  console.log(`PV do admin: ${ADMIN_PV_ID || "nao configurado"}`);
  console.log(`Pin ativo: ${PINAR}`);
  console.log(`IA (OpenRouter): ${ai ? "ativada" : "desativada (fallback regex)"}`);

  if (USE_WEBHOOK) {
    const ok = await setupWebhook();
    if (ok) {
      const webhookPath = `/telegraf/${TOKEN}`;
      server.webhookPath = webhookPath;
      const secretPath = `/${TOKEN}`;
      const cb = (req, res) => {
        if (req.url === secretPath || req.url === webhookPath) {
          bot.handleUpdate(JSON.parse(require("fs").readFileSync(0)));
        } else {
          res.writeHead(404).end();
        }
      };
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        const ts = new Date().toISOString();
        if (req.url === "/health" || req.url === "/" || req.url === "/ping" || req.url === "/keepalive") {
          if (req.url === "/health" || req.url === "/") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "online", mode: "webhook", uptime: process.uptime(), timestamp: ts }));
          } else {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("pong");
          }
          return;
        }
        if (req.url === `/${TOKEN}`) {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const update = JSON.parse(body);
              bot.handleUpdate(update);
              res.writeHead(200).end("ok");
            } catch (e) {
              console.error("Erro processando update:", e.message);
              res.writeHead(400).end("bad request");
            }
          });
        } else {
          res.writeHead(404).end("not found");
        }
      });
      console.log("Webhook handler registrado no servidor HTTP.");
    } else {
      console.log("Fallback para polling...");
      bot.launch();
    }
  } else {
    bot.launch();
  }

  console.log("Crons:");
  console.log("  - 08:00, 11:55, 15:55, 19:55: tarefas diarias");
  console.log("  - 09:00 segunda: tarefas semanais (Yan)");
  console.log("  - 09:00 dia 1: lembrete contabilidade mensal");
  console.log("Pronto.");
}

main().catch((e) => { console.error("Erro fatal:", e); process.exit(1); });

process.once("SIGINT", () => { server.close(); bot.stop("SIGINT"); });
process.once("SIGTERM", () => { server.close(); bot.stop("SIGTERM"); });
