// MDM Test Lab — painel local para testar dispositivos MDM com tela e logs reais (ADB)
// e criar bugs no Jira direto do painel.
//
// Rodar: npm install && npm start
// Depois abrir: http://localhost:4545 (ou a porta definida no .env)

require('dotenv').config();
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { createTransports } = require('./transports');

const ADB_PATH = process.env.ADB_PATH || 'adb';
const PORT = process.env.PORT || 4545;
const MDM_PACKAGE = process.env.MDM_PACKAGE || 'com.mdmservice';

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'MDM';
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE || 'Bug';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers de ADB ----------

function runAdb(args, { buffer = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      ADB_PATH,
      args,
      { maxBuffer: 20 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr && stderr.toString()) || err.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

// Conexão sem cabo: Wi-Fi (adb tcpip / pareamento do Android 11+) e Bluetooth
// (tethering por Bluetooth — perfil PAN — com o adb rodando por cima).
const transports = createTransports(runAdb);

async function shellProp(serial, prop) {
  try {
    const out = await runAdb(['-s', serial, 'shell', 'getprop', prop]);
    return out.trim();
  } catch {
    return '';
  }
}

async function listDevices() {
  const raw = await runAdb(['devices', '-l']);
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('List of devices attached'));

  const devices = lines.map((line) => {
    const parts = line.split(/\s+/);
    const serial = parts[0];
    const transport = transports.transportForSerial(serial);
    return {
      serial,
      state: parts[1] || 'unknown',
      transport,
      transportLabel: transports.transportLabel(transport),
    };
  });

  const withInfo = await Promise.all(
    devices.map(async (d) => {
      if (d.state !== 'device') {
        return { ...d, manufacturer: '', model: '', androidVersion: '' };
      }
      const [manufacturer, model, androidVersion] = await Promise.all([
        shellProp(d.serial, 'ro.product.manufacturer'),
        shellProp(d.serial, 'ro.product.model'),
        shellProp(d.serial, 'ro.build.version.release'),
      ]);
      return { ...d, manufacturer, model, androidVersion };
    })
  );

  return withInfo;
}

async function getScreenshot(serial) {
  return runAdb(['-s', serial, 'exec-out', 'screencap', '-p'], { buffer: true });
}

// PID nunca pode ser 0/1 (init) nem vazio — se algum parsing bugado devolver
// isso, tratamos como "não achei" em vez de filtrar errado.
function isValidPid(pid) {
  return !!pid && /^\d+$/.test(pid) && pid !== '0' && pid !== '1';
}

// "ps" tem colunas em ordens diferentes dependendo do toolbox/busybox/toybox
// do aparelho (às vezes USER vem antes do PID, às vezes é o contrário). Em vez
// de assumir uma posição fixa, lemos o cabeçalho pra achar a coluna "PID" de
// verdade, e casamos o pacote pela última coluna (NAME/CMD).
function parsePidFromPs(out, pkg) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const header = lines[0].split(/\s+/);
  const pidIdx = header.findIndex((h) => /^pid$/i.test(h));
  if (pidIdx === -1) return null;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(/\s+/);
    if (cols.length <= pidIdx) continue;
    const name = cols[cols.length - 1];
    if (name === pkg || lines[i].includes(pkg)) {
      const pid = cols[pidIdx];
      if (isValidPid(pid)) return pid;
    }
  }
  return null;
}

// PID do processo do app do MDM no aparelho, pra filtrar o logcat só pelo que
// interessa (em vez do log inteiro do Android: encoder de vídeo, gralloc, etc.)
// Tenta 3 formas diferentes porque aparelhos com Android antigo (ex.: PAX A910
// em Android 6) muitas vezes não têm "pidof" nem "ps -A" no toolbox deles, e o
// formato de colunas do "ps" varia de fabricante pra fabricante.
async function getAppPid(serial) {
  try {
    const out = await runAdb(['-s', serial, 'shell', 'pidof', MDM_PACKAGE]);
    const pid = out.trim().split(/\s+/)[0];
    if (isValidPid(pid)) return pid;
  } catch {
    /* pidof pode não existir nesse aparelho — segue pro próximo método */
  }

  try {
    const out = await runAdb(['-s', serial, 'shell', 'ps', '-A']);
    const pid = parsePidFromPs(out, MDM_PACKAGE);
    if (pid) return pid;
  } catch {
    /* "ps -A" também pode não existir em versões bem antigas do Android */
  }

  try {
    const out = await runAdb(['-s', serial, 'shell', 'ps']);
    const pid = parsePidFromPs(out, MDM_PACKAGE);
    if (pid) return pid;
  } catch {
    /* nada funcionou */
  }

  return null;
}

// Filtra o logcat pelo PID do app no lado do Node (não confia no "--pid" do
// adb, que não existe em versões antigas do Android) — sempre pede o formato
// "threadtime" pra garantir que dá pra achar a coluna do PID em qualquer aparelho.
async function getLogs(serial, lines = 300) {
  const pid = await getAppPid(serial);
  const windowSize = Math.max(lines * 8, 3000);
  const raw = await runAdb(['-s', serial, 'logcat', '-v', 'threadtime', '-d', '-t', String(windowSize)]);

  if (!pid) {
    return {
      text:
        `[Aviso: não encontrei o processo "${MDM_PACKAGE}" rodando no aparelho — mostrando o log geral, sem filtro]\n\n` +
        raw.split('\n').slice(-lines).join('\n'),
      filtered: false,
      pid: null,
      package: MDM_PACKAGE,
    };
  }

  const pidStr = String(pid);
  const matched = raw.split('\n').filter((line) => {
    const m = line.match(/^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+(\d+)\s+[A-Z]\s/);
    return m && m[1] === pidStr;
  });

  const tail = matched.slice(-lines);
  if (!tail.length) {
    return {
      text: `[O processo ${MDM_PACKAGE} (PID ${pid}) está rodando, mas não encontrei linhas dele nas últimas ${windowSize} linhas do log desse aparelho. Tente atualizar de novo, ou dispare o comando de novo e atualize logo em seguida.]`,
      filtered: true,
      pid,
      package: MDM_PACKAGE,
    };
  }

  return { text: tail.join('\n'), filtered: true, pid, package: MDM_PACKAGE };
}

async function clearLogs(serial) {
  await runAdb(['-s', serial, 'logcat', '-c']);
}

// ---------- rotas da API ----------

app.get('/api/devices', async (req, res) => {
  try {
    const devices = await listDevices();
    res.json({ devices });
  } catch (err) {
    res.status(500).json({
      error:
        'Não consegui rodar o "adb". Verifique se o Android Platform Tools está instalado e ' +
        'se ADB_PATH no .env aponta pro executável certo. Detalhe: ' + err.message,
    });
  }
});

app.get('/api/devices/:serial/screenshot', async (req, res) => {
  try {
    const png = await getScreenshot(req.params.serial);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao capturar a tela: ' + err.message });
  }
});

app.get('/api/devices/:serial/logs', async (req, res) => {
  try {
    const lines = parseInt(req.query.lines, 10) || 300;
    const result = await getLogs(req.params.serial, lines);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao ler o logcat: ' + err.message });
  }
});

app.post('/api/devices/:serial/logs/clear', async (req, res) => {
  try {
    await clearLogs(req.params.serial);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao limpar o logcat: ' + err.message });
  }
});

// ---------- conexão sem cabo: Bluetooth (PAN) e Wi-Fi ----------

// Estado do Bluetooth do PC: tem rádio? está ligado? quais aparelhos estão
// pareados? o PAN (tethering) já subiu (o PC pegou IP numa interface Bluetooth)?
app.get('/api/bluetooth/pc', async (req, res) => {
  try {
    const info = await transports.pcBluetooth();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: 'Não consegui ler o Bluetooth do PC: ' + err.message });
  }
});

// Abre o painel de Bluetooth do Windows — o pareamento em si é do sistema, não
// existe API pública pra parear sem interação.
app.post('/api/bluetooth/open-settings', async (req, res) => {
  try {
    await transports.openWindowsBluetoothSettings();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Não consegui abrir as configurações de Bluetooth: ' + err.message });
  }
});

// Abre "Dispositivos e Impressoras" — o unico lugar do Windows 11 que tem o menu
// "Conectar usando -> Ponto de acesso", que e o passo que sobe a rede PAN.
app.post('/api/bluetooth/open-devices-panel', async (req, res) => {
  try {
    await transports.openWindowsDevicesPanel();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Nao consegui abrir "Dispositivos e Impressoras": ' + err.message });
  }
});

// Candidatos de IP do outro lado do PAN (gateway .1 da faixa do Bluetooth + quem
// já apareceu na tabela de vizinhos).
app.get('/api/bluetooth/pan', async (req, res) => {
  try {
    const [pc, candidates] = await Promise.all([
      transports.pcBluetooth().catch(() => null),
      transports.panCandidates(),
    ]);
    res.json({ pc, candidates, port: transports.DEFAULT_ADB_TCP_PORT });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao procurar a rede Bluetooth (PAN): ' + err.message });
  }
});

// Tenta o adb connect em cada candidato do PAN até um colar. Cada tentativa que
// falha volta na resposta pra dar pra ver onde travou.
app.post('/api/bluetooth/connect', async (req, res) => {
  const port = parseInt(req.body && req.body.port, 10) || transports.DEFAULT_ADB_TCP_PORT;
  try {
    const explicitHost = req.body && req.body.host;

    // Sem PAN no ar, o adb connect só ficaria ~20s pendurado no timeout de TCP —
    // melhor avisar na hora o que está faltando. Se o usuário digitou um IP na mão,
    // respeitamos a escolha dele e tentamos de qualquer forma.
    if (!explicitHost) {
      const pc = await transports.pcBluetooth().catch(() => null);

      // Caso que mais confunde: o Windows mostra o aparelho "conectado", mas a
      // interface só tem APIPA (169.254.x.x) porque o terminal não respondeu ao
      // DHCP. Sem endereço da rede do terminal não existe rota pra falar adb.
      if (pc && pc.panDhcpPending) {
        return res.status(409).json({
          error:
            'O link Bluetooth subiu, mas o terminal não entregou IP (o Windows ficou com um endereço ' +
            '169.254.x.x, que é o "sem DHCP"). No terminal, desligue e ligue o "Tethering por Bluetooth"; ' +
            'no Windows, desconecte e conecte de novo em "Conectar usando → Ponto de acesso". ' +
            'O Android também recusa servir o tethering quando ele mesmo está sem rede — confirme que o ' +
            'terminal tem Wi-Fi ou dados ativos.',
          pc,
        });
      }

      if (pc && !pc.panUp) {
        return res.status(409).json({
          error:
            'A rede Bluetooth (PAN) ainda não está no ar neste PC. Ligue o "Tethering por Bluetooth" no ' +
            'terminal e, no Windows, clique no terminal pareado → Conectar usando → Ponto de acesso. ' +
            'Depois tente de novo.',
          pc,
        });
      }
    }

    const hosts = explicitHost ? [explicitHost] : await transports.panCandidates();
    const attempts = [];

    for (const host of hosts) {
      try {
        const result = await transports.adbConnect({ host, port, transport: 'bluetooth' });
        return res.json({ ok: true, connected: result.target, attempts });
      } catch (err) {
        attempts.push({ host: `${host}:${port}`, error: err.message });
      }
    }

    res.status(502).json({
      error:
        'Nenhum aparelho respondeu ao adb pela rede Bluetooth. Confira o passo a passo do cartão ' +
        'Bluetooth (parear → tethering por Bluetooth no aparelho → conectar como ponto de acesso no ' +
        'Windows → "Habilitar sem fio" uma vez por cabo).',
      attempts,
    });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao conectar pela rede Bluetooth: ' + err.message });
  }
});

app.post('/api/adb/connect', async (req, res) => {
  try {
    const { host, transport } = req.body || {};
    const port = parseInt(req.body && req.body.port, 10) || transports.DEFAULT_ADB_TCP_PORT;
    const result = await transports.adbConnect({ host, port, transport: transport || 'wifi' });
    res.json({ ok: true, connected: result.target, output: result.output });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Pareamento por código (Android 11+, "Depuração sem fio"). Vale tanto pra Wi-Fi
// quanto pro IP do PAN do Bluetooth.
app.post('/api/adb/pair', async (req, res) => {
  try {
    const { host, port, code } = req.body || {};
    const result = await transports.adbPair({ host, port, code });
    res.json({ ok: true, output: result.output });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/adb/disconnect', async (req, res) => {
  try {
    const result = await transports.adbDisconnect((req.body && req.body.serial) || '');
    res.json({ ok: true, output: result.output });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao desconectar: ' + err.message });
  }
});

// "Habilitar sem fio": liga o modo TCP no aparelho (precisa do cabo só nessa vez)
// e devolve os IPs dele, já separando qual é o do Bluetooth (bt-pan) e qual é o
// do Wi-Fi — cada um vira um botão de conectar no painel.
app.post('/api/devices/:serial/wireless', async (req, res) => {
  try {
    const port = parseInt(req.body && req.body.port, 10) || transports.DEFAULT_ADB_TCP_PORT;
    const result = await transports.enableWireless(req.params.serial, port);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao habilitar o adb sem fio no aparelho: ' + err.message });
  }
});

app.get('/api/devices/:serial/interfaces', async (req, res) => {
  try {
    const interfaces = await transports.deviceInterfaces(req.params.serial);
    res.json({ interfaces });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao ler as interfaces de rede do aparelho: ' + err.message });
  }
});

// Bluetooth do lado do aparelho: ligado/desligado, nome e se o tethering (bt-pan)
// está no ar. Serve pra diagnosticar o PAN e pra conferir política de Bluetooth
// aplicada pelo portal MDM.
app.get('/api/devices/:serial/bluetooth', async (req, res) => {
  try {
    const status = await transports.deviceBluetoothStatus(req.params.serial);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao ler o Bluetooth do aparelho: ' + err.message });
  }
});

// ---------- ações em lote (testar vários terminais de uma vez) ----------

function serialsFromBody(body) {
  const list = (body && body.serials) || [];
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

// Zera o logcat de vários aparelhos ao mesmo tempo, pra todos começarem o teste
// "do zero" no mesmo instante antes de disparar o comando no portal.
app.post('/api/batch/logs/clear', async (req, res) => {
  const serials = serialsFromBody(req.body);
  if (!serials.length) return res.status(400).json({ error: 'Selecione ao menos um dispositivo.' });

  const results = await Promise.all(
    serials.map(async (serial) => {
      try {
        await clearLogs(serial);
        return { serial, ok: true };
      } catch (err) {
        return { serial, ok: false, error: err.message };
      }
    })
  );
  res.json({ results });
});

// ---------- criação de bug no Jira ----------

// Serial de conexão por rede vem como "192.168.44.1:5555" — o ":" (e afins) não
// vale em nome de anexo, então vira "_".
function safeFileTag(serial) {
  return String(serial).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Um bug pode cobrir vários terminais (o mesmo comando do portal falhando em
// modelos diferentes) — cada aparelho ganha sua própria seção com o log dele.
// Usado tanto na descrição da issue nova quanto no corpo de um comentário
// (a API do Jira aceita ADF nos dois casos).
function adfDoc({ description, devices }) {
  const content = [
    { type: 'paragraph', content: [{ type: 'text', text: description || '(sem descrição adicional)' }] },
  ];

  if (devices.length) {
    const heading = devices.length > 1 ? `Dispositivos (${devices.length})` : 'Dispositivo';
    content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: heading }] });

    // Com log por aparelho, o orçamento de 8000 caracteres é dividido entre eles
    // pra não estourar o tamanho da descrição/comentário no Jira.
    const logBudget = Math.floor(8000 / devices.length);

    for (const dev of devices) {
      content.push({ type: 'paragraph', content: [{ type: 'text', text: dev.line }] });
      if (dev.logs) {
        content.push({ type: 'codeBlock', content: [{ type: 'text', text: dev.logs.slice(-logBudget) }] });
      }
    }
  }

  return { type: 'doc', version: 1, content };
}

// Tela + log de cada aparelho selecionado, em paralelo — usado tanto pra abrir
// um bug novo quanto pra comentar um card existente com evidência fresca. Uma
// captura que falha (aparelho caiu no meio do teste) não derruba a chamada inteira.
async function collectEvidence(serials) {
  const connected = await listDevices();
  return Promise.all(
    serials.map(async (s) => {
      const [shot, logsResult] = await Promise.all([
        getScreenshot(s).catch(() => null),
        getLogs(s, 500).catch(() => ({ text: '' })),
      ]);
      const dev = connected.find((d) => d.serial === s) || {};
      return {
        serial: s,
        screenshot: shot,
        logs: (logsResult && logsResult.text) || '',
        line:
          `Fabricante: ${dev.manufacturer || '?'} · Modelo: ${dev.model || '?'} · Serial: ${s} · ` +
          `Android: ${dev.androidVersion || '?'} · Conexão: ${dev.transportLabel || '?'}`,
      };
    })
  );
}

// Anexa screenshot e log completo de cada aparelho a uma issue, se deu pra
// capturar. Usado tanto ao criar quanto ao comentar um card.
async function attachEvidence(issueKey, auth, evidence) {
  const form = new FormData();
  let hasAttachment = false;
  const stamp = Date.now();
  for (const dev of evidence) {
    if (dev.screenshot) {
      form.append('file', dev.screenshot, {
        filename: `tela-${safeFileTag(dev.serial)}-${stamp}.png`,
        contentType: 'image/png',
      });
      hasAttachment = true;
    }
    if (dev.logs) {
      form.append('file', Buffer.from(dev.logs, 'utf8'), {
        filename: `logcat-${safeFileTag(dev.serial)}-${stamp}.txt`,
        contentType: 'text/plain',
      });
      hasAttachment = true;
    }
  }
  if (!hasAttachment) return;
  await axios.post(`${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/attachments`, form, {
    auth,
    headers: { ...form.getHeaders(), 'X-Atlassian-Token': 'no-check' },
    maxBodyLength: Infinity,
  });
}

app.post('/api/bugs', async (req, res) => {
  const { title, description } = req.body || {};
  const serials = [
    ...new Set([...(Array.isArray(req.body && req.body.serials) ? req.body.serials : []), (req.body || {}).serial].filter(Boolean)),
  ];
  const serial = serials[0];

  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(400).json({
      error:
        'Jira não está configurado ainda. Preencha JIRA_BASE_URL, JIRA_EMAIL e JIRA_API_TOKEN no ' +
        'arquivo .env (veja o README) antes de reportar bugs.',
    });
  }
  if (!serial || !title) {
    return res.status(400).json({ error: 'Informe ao menos o dispositivo e um título para o bug.' });
  }

  const auth = { username: JIRA_EMAIL, password: JIRA_API_TOKEN };

  try {
    const evidence = await collectEvidence(serials);

    const createResp = await axios.post(
      `${JIRA_BASE_URL}/rest/api/3/issue`,
      {
        fields: {
          project: { key: JIRA_PROJECT_KEY },
          summary: title,
          issuetype: { name: JIRA_ISSUE_TYPE },
          description: adfDoc({ description, devices: evidence }),
        },
      },
      { auth, headers: { 'Content-Type': 'application/json' } }
    );

    const issueKey = createResp.data.key;
    await attachEvidence(issueKey, auth, evidence);

    res.json({ key: issueKey, url: `${JIRA_BASE_URL}/browse/${issueKey}` });
  } catch (err) {
    const jiraMsg = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ error: 'Falha ao criar o bug no Jira: ' + jiraMsg });
  }
});

// ---------- comentário em card já existente no Jira ----------

// Chave de issue vem como "MDM-123" (ou às vezes em minúsculo, colado do Jira) —
// normaliza e valida o formato antes de tentar falar com a API.
function normalizeIssueKey(raw) {
  const key = String(raw || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9]*-\d+$/.test(key) ? key : null;
}

app.post('/api/issues/:key/comments', async (req, res) => {
  const issueKey = normalizeIssueKey(req.params.key);
  const comment = ((req.body && req.body.comment) || '').trim();
  const attach = !(req.body && req.body.attach === false);
  const serials = [
    ...new Set([...(Array.isArray(req.body && req.body.serials) ? req.body.serials : []), (req.body || {}).serial].filter(Boolean)),
  ];

  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(400).json({
      error:
        'Jira não está configurado ainda. Preencha JIRA_BASE_URL, JIRA_EMAIL e JIRA_API_TOKEN no ' +
        'arquivo .env (veja o README) antes de comentar cards.',
    });
  }
  if (!issueKey) {
    return res.status(400).json({ error: 'Informe a chave do card no formato "MDM-123".' });
  }
  if (!comment) {
    return res.status(400).json({ error: 'Escreva um comentário.' });
  }

  const auth = { username: JIRA_EMAIL, password: JIRA_API_TOKEN };

  try {
    const evidence = attach && serials.length ? await collectEvidence(serials) : [];

    await axios.post(
      `${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/comment`,
      { body: adfDoc({ description: comment, devices: evidence }) },
      { auth, headers: { 'Content-Type': 'application/json' } }
    );

    await attachEvidence(issueKey, auth, evidence);

    res.json({ key: issueKey, url: `${JIRA_BASE_URL}/browse/${issueKey}` });
  } catch (err) {
    const jiraMsg = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).json({ error: 'Falha ao comentar no card do Jira: ' + jiraMsg });
  }
});

app.listen(PORT, () => {
  console.log(`MDM Test Lab rodando em http://localhost:${PORT}`);
});
