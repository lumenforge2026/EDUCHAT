// Transportes de conexão com os terminais: USB (cabo), Wi-Fi (adb tcpip / pareamento
// do Android 11+) e Bluetooth (PAN — tethering por Bluetooth).
//
// Por que Bluetooth aqui é "PAN" e não "adb via Bluetooth": o Android não expõe o
// adb (shell, screencap, logcat) por Bluetooth — não existe transporte adb sobre
// BT. O que existe é o tethering por Bluetooth (perfil PAN), que cria uma rede IP
// por cima do link Bluetooth (o aparelho vira o gateway dessa rede). Com essa
// rede no ar, o adb roda por TCP normalmente e todas as features do painel (tela,
// logcat, bug no Jira) funcionam sem cabo. É esse fluxo que este módulo automatiza.

const { execFile } = require('child_process');

const DEFAULT_ADB_TCP_PORT = 5555;

// Faixas históricas do tethering do Android (o gateway é o .1 — o próprio
// aparelho). Atenção: isso é só o palpite de último recurso. Do Android 11 em
// diante o tethering usa o servidor DHCP novo (dumpsys tethering mostra
// "enableLegacyDhcpServer: false"), que SORTEIA a /24 dentro de 192.168.0.0/16
// em vez de fixar essas faixas. Por isso o caminho principal de descoberta é
// olhar a interface Bluetooth do próprio PC (IP, rota e vizinho ARP) — quem
// atribuiu o endereço foi o aparelho, então o dado real está ali.
const TETHER_SUBNETS = {
  bluetooth: '192.168.44.', // tethering por Bluetooth (interface bt-pan)
  usb: '192.168.42.',       // tethering por USB (rndis)
  wifi: '192.168.43.',      // hotspot Wi-Fi do aparelho
};

// Prefixos /24 que já vimos numa interface Bluetooth deste PC. Preenchido por
// pcBluetooth()/panCandidates() e usado pra classificar como "Bluetooth" um
// serial de rede que não passou pelo painel (conexão manual, painel reiniciado).
const observedPanPrefixes = new Set();

function prefixOf(ip) {
  const parts = String(ip).split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') + '.' : null;
}

// 169.254.x.x é o APIPA do Windows: o endereço que ele dá a si mesmo quando o
// DHCP não respondeu. Numa interface de PAN isso significa "o link Bluetooth
// subiu, mas o terminal não entregou IP" — não dá pra falar adb por ali, e o
// ".1" dessa faixa não é gateway de ninguém.
function isLinkLocal(ip) {
  return /^169\.254\./.test(String(ip));
}

// A tabela de vizinhos traz multicast (224.x–239.x) e o broadcast da rede
// (.255) junto com os hosts de verdade — tentar adb connect neles é tempo
// jogado fora.
function isUsableHost(ip) {
  const octets = String(ip).split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (octets[0] >= 224) return false;
  if (octets[3] === 0 || octets[3] === 255) return false;
  return true;
}

// Como cada serial entrou no adb. Preenchido quando a conexão é feita pelo painel;
// para quem já estava conectado antes, cai no palpite por faixa de IP.
const connectionOrigin = new Map();

function rememberOrigin(serial, transport) {
  if (serial && transport) connectionOrigin.set(serial, transport);
}

function forgetOrigin(serial) {
  connectionOrigin.delete(serial);
}

// USB aparece como serial "cru" (ex.: 0123456789ABCDEF); rede aparece como
// "ip:porta". Entre os de rede, a faixa 192.168.44.x é do PAN do Bluetooth.
function transportForSerial(serial) {
  const remembered = connectionOrigin.get(serial);
  if (remembered) return remembered;

  const m = String(serial).match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/);
  if (!m) return 'usb';
  const prefix = prefixOf(m[1]);
  if (prefix && observedPanPrefixes.has(prefix)) return 'bluetooth';
  if (m[1].startsWith(TETHER_SUBNETS.bluetooth)) return 'bluetooth';
  return 'wifi';
}

const TRANSPORT_LABELS = { usb: 'USB', wifi: 'Wi-Fi', bluetooth: 'Bluetooth' };

function transportLabel(transport) {
  return TRANSPORT_LABELS[transport] || transport;
}

// ---------- PowerShell (só Windows) ----------

function runPowerShell(script, { timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('A detecção de Bluetooth do painel usa PowerShell e só roda no Windows.'));
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 4 * 1024 * 1024, timeout, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error((stderr && stderr.trim()) || err.message));
          return;
        }
        resolve(stdout || '');
      }
    );
  });
}

// Índices das interfaces de rede Bluetooth deste PC.
//
// Identificamos pela DESCRIÇÃO do hardware ("Bluetooth Device (Personal Area
// Network)"), não pelo nome da conexão: o nome é só um rótulo do Windows e nem
// sempre diz Bluetooth — num teste real aqui, um adaptador de tethering apareceu
// batizado de "Ethernet 2". O nome entra só como reforço, pra cobrir adaptador
// renomeado à mão pelo usuário.
const PS_BT_IFACE_INDEXES =
  "@(Get-NetAdapter -ErrorAction SilentlyContinue | " +
  "Where-Object { $_.InterfaceDescription -match 'Bluetooth' -or $_.Name -match 'Bluetooth' } | " +
  'Select-Object -ExpandProperty ifIndex -Unique)';

// PowerShell devolve objeto solto quando é 1 item e array quando são vários —
// normalizamos pra sempre tratar como lista.
function asList(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseJsonList(raw) {
  const text = (raw || '').trim();
  if (!text) return [];
  try {
    return asList(JSON.parse(text));
  } catch {
    return [];
  }
}

// ---------- Bluetooth do lado do PC ----------

// Rádio Bluetooth do PC + aparelhos pareados. No PnP:
//   BTHENUM\DEV_*  → aparelho pareado (o que interessa listar)
//   BTHENUM\{guid} → perfil/serviço daquele aparelho (A2DP, AVRCP…) — ruído
//   BTH\MS_*       → enumeradores da Microsoft, não são o rádio de verdade
async function pcBluetooth() {
  const script = [
    '$out = @{}',
    'try {',
    "  $bt = @(Get-PnpDevice -Class Bluetooth -ErrorAction Stop)",
    "  $out.radios = @($bt | Where-Object { $_.InstanceId -notlike 'BTHENUM*' -and $_.InstanceId -notlike 'BTH\\MS_*' } | Select-Object FriendlyName, Status)",
    "  $out.paired = @($bt | Where-Object { $_.InstanceId -like 'BTHENUM\\DEV_*' } | Select-Object FriendlyName, Status, InstanceId)",
    '} catch { $out.error = $_.Exception.Message }',
    'try {',
    '  $idx = ' + PS_BT_IFACE_INDEXES,
    '  $out.panAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $idx -contains $_.InterfaceIndex } | Select-Object InterfaceAlias, IPAddress, PrefixLength)',
    '} catch { $out.panAddresses = @() }',
    '$out | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');

  const raw = await runPowerShell(script);
  let data = {};
  try {
    data = JSON.parse((raw || '').trim() || '{}') || {};
  } catch {
    data = {};
  }

  const radios = asList(data.radios);
  const paired = asList(data.paired);
  const panAddresses = asList(data.panAddresses);

  // Toda faixa vista numa interface Bluetooth é rede de PAN — memoriza pra
  // classificar corretamente os seriais que vierem dela. APIPA não conta:
  // é endereço que o Windows inventou, não veio do terminal.
  const usableAddresses = panAddresses.filter((a) => a && !isLinkLocal(a.IPAddress));
  for (const addr of usableAddresses) {
    const prefix = prefixOf(addr.IPAddress);
    if (prefix) observedPanPrefixes.add(prefix);
  }

  return {
    hasRadio: radios.length > 0,
    radioOk: radios.some((r) => r && r.Status === 'OK'),
    radios: radios.map((r) => ({ name: r.FriendlyName, status: r.Status })),
    paired: paired.map((p) => ({ name: p.FriendlyName, status: p.Status, id: p.InstanceId })),
    // PAN "no ar" = o PC tem endereço USÁVEL numa interface Bluetooth. Só o link
    // Bluetooth existir não basta: com APIPA não há rota pro terminal.
    panUp: usableAddresses.length > 0,
    // Link subiu mas o terminal não entregou IP — é o caso que mais confunde,
    // porque o Windows mostra "conectado" e nada funciona.
    panDhcpPending: usableAddresses.length === 0 && panAddresses.length > 0,
    panAddresses: panAddresses.map((a) => ({
      iface: a.InterfaceAlias,
      ip: a.IPAddress,
      prefix: a.PrefixLength,
      linkLocal: isLinkLocal(a.IPAddress),
    })),
    error: data.error || null,
  };
}

// Abre o painel de Bluetooth do Windows. O pareamento em si é do sistema — não há
// API pública pra parear sem interação do usuário.
async function openWindowsBluetoothSettings() {
  await runPowerShell('Start-Process "ms-settings:bluetooth"');
}

// Abre "Dispositivos e Impressoras" (painel clássico).
//
// Por que precisa dele: é o único lugar do Windows 11 com o menu "Conectar
// usando → Ponto de acesso", que é justamente o que sobe a rede PAN. A tela
// nova (Configurações → Bluetooth e dispositivos) pareia, mas não oferece essa
// opção — dá pra pareá-lo e ficar sem rede nenhuma, sem nenhuma pista do porquê.
async function openWindowsDevicesPanel() {
  await runPowerShell("Start-Process control -ArgumentList 'printers'");
}

// Onde procurar o aparelho do outro lado do PAN. Em vez de chutar a faixa (que o
// Android 11+ sorteia), olhamos a interface Bluetooth deste PC — o endereço dela
// foi dado pelo próprio aparelho por DHCP:
//   1. o gateway da rota dessa interface — é o aparelho, é a resposta certa;
//   2. o .1 da /24 que o PC recebeu — como o Android sempre se põe no .1;
//   3. vizinhos ARP dessa interface — quem já respondeu por ali;
//   4. 192.168.44.1 — palpite histórico, só pra não voltar lista vazia.
async function panCandidates() {
  const script = [
    '$out = @{}',
    '$idx = ' + PS_BT_IFACE_INDEXES,
    '$out.addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $idx -contains $_.InterfaceIndex } | Select-Object InterfaceAlias, InterfaceIndex, IPAddress, PrefixLength)',
    "$out.gateways = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $idx -contains $_.InterfaceIndex -and $_.NextHop -ne '0.0.0.0' } | Select-Object -ExpandProperty NextHop -Unique)",
    "$out.neighbors = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $idx -contains $_.InterfaceIndex -and $_.State -ne 'Unreachable' -and $_.IPAddress -notlike '224.*' -and $_.IPAddress -ne '255.255.255.255' } | Select-Object -ExpandProperty IPAddress -Unique)",
    '$out | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');

  const candidates = new Set();

  try {
    const raw = await runPowerShell(script);
    const data = JSON.parse((raw || '').trim() || '{}') || {};

    for (const gw of asList(data.gateways)) {
      if (typeof gw === 'string' && isUsableHost(gw)) candidates.add(gw);
    }

    for (const addr of asList(data.addresses)) {
      if (!addr || isLinkLocal(addr.IPAddress)) continue; // APIPA: não veio do terminal
      const prefix = prefixOf(addr.IPAddress);
      if (!prefix) continue;

      // A faixa da interface Bluetooth é, por definição, a rede do PAN — guardamos
      // pra saber depois que um serial dela entrou por Bluetooth.
      observedPanPrefixes.add(prefix);

      // O chute do ".1" só faz sentido numa /24 ou mais estreita, onde os três
      // primeiros octetos definem a rede. Numa /16 (visto aqui num PAN sem DHCP)
      // esse endereço não é o gateway de nada.
      if (Number(addr.PrefixLength) >= 24) candidates.add(prefix + '1');
    }

    for (const ip of asList(data.neighbors)) {
      if (typeof ip === 'string' && isUsableHost(ip) && !isLinkLocal(ip)) candidates.add(ip);
    }
  } catch {
    /* sem PowerShell/cmdlets de rede: cai no palpite histórico abaixo */
  }

  candidates.add(TETHER_SUBNETS.bluetooth + '1');
  return [...candidates];
}

// ---------- interfaces de rede do aparelho (visto pelo adb) ----------

function ifaceKind(name) {
  if (/^bt-pan/i.test(name)) return 'bluetooth';
  if (/^wlan/i.test(name)) return 'wifi';
  if (/^(rndis|usb)/i.test(name)) return 'usb';
  if (/^eth/i.test(name)) return 'ethernet';
  return 'other';
}

// "ip addr" moderno: "12: wlan0: <UP...>" seguido de "inet 192.168.0.5/24"
function parseIpAddr(out) {
  const found = [];
  let current = null;
  for (const line of out.split('\n')) {
    const head = line.match(/^\s*\d+:\s+([^:@\s]+)[:@]/);
    if (head) {
      current = head[1];
      continue;
    }
    const inet = line.match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})/);
    if (inet && current && inet[1] !== '127.0.0.1') found.push({ iface: current, ip: inet[1] });
  }
  return found;
}

// "ifconfig" (aparelhos antigos, ex.: PAX A910 em Android 6, sem "ip" no toolbox)
function parseIfconfig(out) {
  const found = [];
  let current = null;
  for (const line of out.split('\n')) {
    const head = line.match(/^(\S+)\s+Link encap/);
    if (head) current = head[1];
    const alt = line.match(/^(\S+):\s+flags=/);
    if (alt) current = alt[1];
    const inet = line.match(/inet\s+(?:addr:)?(\d{1,3}(?:\.\d{1,3}){3})/);
    if (inet && current && inet[1] !== '127.0.0.1') found.push({ iface: current, ip: inet[1] });
  }
  return found;
}

// "netcfg" (Android bem antigo): "wlan0 UP 192.168.0.5/24 ..."
function parseNetcfg(out) {
  const found = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3})/);
    if (m && m[2] !== '127.0.0.1' && m[2] !== '0.0.0.0') found.push({ iface: m[1], ip: m[2] });
  }
  return found;
}

function dedupeInterfaces(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.iface + '|' + item.ip;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, kind: ifaceKind(item.iface) });
  }
  return out;
}

// IPs do aparelho, por interface. Tenta 3 comandos porque o toolbox varia muito
// entre fabricante/versão do Android (mesmo motivo do fallback do PID no logcat).
function makeDeviceInterfaces(runAdb) {
  return async function deviceInterfaces(serial) {
    const attempts = [
      { args: ['-s', serial, 'shell', 'ip', 'addr'], parse: parseIpAddr },
      { args: ['-s', serial, 'shell', 'ifconfig'], parse: parseIfconfig },
      { args: ['-s', serial, 'shell', 'netcfg'], parse: parseNetcfg },
    ];

    for (const attempt of attempts) {
      try {
        const out = await runAdb(attempt.args);
        const parsed = attempt.parse(out);
        if (parsed.length) return dedupeInterfaces(parsed);
      } catch {
        /* comando não existe nesse aparelho — tenta o próximo */
      }
    }
    return [];
  };
}

// ---------- operações de conexão do adb ----------

function looksLikeAdbFailure(out) {
  return /failed to connect|unable to connect|cannot connect|connection refused|no route to host|failed to authenticate|device offline/i.test(
    out || ''
  );
}

function makeAdbConnect(runAdb) {
  return async function adbConnect({ host, port = DEFAULT_ADB_TCP_PORT, transport }) {
    if (!host) throw new Error('Informe o IP do aparelho.');
    const target = `${host}:${port}`;
    let out = '';
    try {
      out = await runAdb(['connect', target]);
    } catch (err) {
      out = err.message || '';
    }
    if (looksLikeAdbFailure(out) || !/connected to/i.test(out)) {
      const hint =
        transport === 'bluetooth'
          ? ' Confirme que o tethering por Bluetooth está ligado no aparelho, que o Windows conectou nele como "ponto de acesso" e que o adb sem fio já foi habilitado (uma vez por cabo, no botão "Habilitar sem fio").'
          : ' Confirme que o aparelho está na mesma rede e que o adb sem fio já foi habilitado (uma vez por cabo, no botão "Habilitar sem fio") ou pareado pelo código do Android 11+.';
      throw new Error(
        `adb connect ${target} não colou: ${(out || '').trim() || 'sem resposta do adb'}.${hint}`
      );
    }
    rememberOrigin(target, transport || transportForSerial(target));
    return { target, output: (out || '').trim() };
  };
}

function makeAdbPair(runAdb) {
  return async function adbPair({ host, port, code }) {
    if (!host || !port || !code) {
      throw new Error('Para parear (Android 11+) informe IP, porta de pareamento e o código de 6 dígitos.');
    }
    let out = '';
    try {
      out = await runAdb(['pair', `${host}:${port}`, String(code)]);
    } catch (err) {
      out = err.message || '';
    }
    if (!/successfully paired/i.test(out)) {
      throw new Error(
        `Pareamento falhou: ${(out || '').trim() || 'sem resposta do adb'}. ` +
          'Confira IP, porta e código na tela "Depuração sem fio → Parear aparelho com código".'
      );
    }
    return { output: out.trim() };
  };
}

function makeAdbDisconnect(runAdb) {
  return async function adbDisconnect(serial) {
    let out = '';
    try {
      out = await runAdb(serial ? ['disconnect', serial] : ['disconnect']);
    } catch (err) {
      out = err.message || '';
    }
    forgetOrigin(serial);
    return { output: (out || '').trim() };
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Liga o modo TCP no aparelho (o "uma vez por cabo"). Depois disso ele aceita
// adb connect por qualquer rede que tenha — Wi-Fi ou o PAN do Bluetooth.
//
// Os IPs são lidos ANTES do "adb tcpip" porque esse comando reinicia o adbd no
// aparelho: por alguns segundos depois dele o "adb shell" falha, e a leitura
// voltaria vazia — justo quando o painel precisa mostrar os alvos de conexão.
// Depois do reinício tentamos de novo (o adbd pode ter voltado, e aí o dado é
// mais fresco); se não voltar em tempo, fica valendo a leitura de antes.
function makeEnableWireless(runAdb, deviceInterfaces) {
  return async function enableWireless(serial, port = DEFAULT_ADB_TCP_PORT) {
    const before = await deviceInterfaces(serial).catch(() => []);
    const out = await runAdb(['-s', serial, 'tcpip', String(port)]);

    let interfaces = before;
    for (const wait of [900, 1500]) {
      await sleep(wait);
      const fresh = await deviceInterfaces(serial).catch(() => []);
      if (fresh.length) {
        interfaces = fresh;
        break;
      }
    }

    return {
      port,
      output: (out || '').trim(),
      interfaces,
      // Alvos prontos pra clicar em "Conectar" no painel.
      targets: interfaces
        .filter((i) => ['bluetooth', 'wifi', 'ethernet'].includes(i.kind))
        .map((i) => ({
          ...i,
          target: `${i.ip}:${port}`,
          transport: i.kind === 'bluetooth' ? 'bluetooth' : 'wifi',
        })),
    };
  };
}

// Estado do tethering visto de dentro do aparelho ("dumpsys tethering"), que
// responde as duas perguntas que travaram o PAN num teste real aqui:
//
//   - o aparelho tem rede própria (upstream)? Sem upstream o Android aceita o
//     link Bluetooth mas não serve o DHCP, e o PC fica com 169.254.x.x;
//   - o ponto de acesso Wi-Fi está ligado? Se estiver, o wlan0 virou AP e o
//     aparelho deixou de ser cliente da rede — o que derruba o adb por Wi-Fi e
//     tira o upstream ao mesmo tempo.
function parseTetheringDump(out) {
  const tetherStates = [];
  let upstream = null;

  for (const raw of out.split('\n')) {
    const line = raw.trim();

    const state = line.match(/^(\S+)\s+-\s+(\w+State)\s+-\s+lastError/);
    if (state) tetherStates.push({ iface: state[1], state: state[2] });

    const up = line.match(/^Current upstream interface\(s\):\s*(.+)$/);
    if (up) {
      const value = up[1].trim();
      upstream = value && value !== 'null' && value !== '[]' ? value : null;
    }
  }

  return {
    tetherStates,
    upstream,
    // wlan em TetheredState = o aparelho está servindo hotspot por Wi-Fi.
    wifiHotspotActive: tetherStates.some((t) => /^(wlan|softap|ap_br)/i.test(t.iface) && /Tethered/i.test(t.state)),
    btPanTethered: tetherStates.some((t) => /^bt-pan/i.test(t.iface) && /Tethered/i.test(t.state)),
  };
}

async function readTethering(runAdb, serial) {
  try {
    const out = await runAdb(['-s', serial, 'shell', 'dumpsys', 'tethering']);
    return parseTetheringDump(out);
  } catch {
    return { tetherStates: [], upstream: null, wifiHotspotActive: false, btPanTethered: false };
  }
}

// Estado do Bluetooth do próprio aparelho — serve tanto pra diagnosticar por que o
// PAN não sobe quanto pra conferir a política de Bluetooth aplicada pelo MDM.
function makeDeviceBluetoothStatus(runAdb, deviceInterfaces) {
  return async function deviceBluetoothStatus(serial) {
    let enabled = null;
    try {
      const out = await runAdb(['-s', serial, 'shell', 'settings', 'get', 'global', 'bluetooth_on']);
      const v = (out || '').trim();
      if (v === '1') enabled = true;
      else if (v === '0') enabled = false;
    } catch {
      /* alguns aparelhos bloqueiam "settings get" — segue sem essa info */
    }

    let name = '';
    try {
      const out = await runAdb(['-s', serial, 'shell', 'settings', 'get', 'secure', 'bluetooth_name']);
      const v = (out || '').trim();
      if (v && v !== 'null') name = v;
    } catch {
      /* opcional */
    }

    const [interfaces, tethering] = await Promise.all([
      deviceInterfaces(serial),
      readTethering(runAdb, serial),
    ]);
    const pan = interfaces.find((i) => i.kind === 'bluetooth') || null;

    return {
      enabled,
      name,
      // bt-pan com IP = tethering por Bluetooth ativo nesse momento.
      panActive: !!pan,
      panIp: pan ? pan.ip : null,
      interfaces,
      upstream: tethering.upstream,
      wifiHotspotActive: tethering.wifiHotspotActive,
      btPanTethered: tethering.btPanTethered,
      tetherStates: tethering.tetherStates,
    };
  };
}

function createTransports(runAdb) {
  const deviceInterfaces = makeDeviceInterfaces(runAdb);
  return {
    DEFAULT_ADB_TCP_PORT,
    TETHER_SUBNETS,
    transportForSerial,
    transportLabel,
    rememberOrigin,
    forgetOrigin,
    pcBluetooth,
    openWindowsBluetoothSettings,
    openWindowsDevicesPanel,
    panCandidates,
    deviceInterfaces,
    adbConnect: makeAdbConnect(runAdb),
    adbPair: makeAdbPair(runAdb),
    adbDisconnect: makeAdbDisconnect(runAdb),
    enableWireless: makeEnableWireless(runAdb, deviceInterfaces),
    deviceBluetoothStatus: makeDeviceBluetoothStatus(runAdb, deviceInterfaces),
  };
}

module.exports = { createTransports, transportForSerial, transportLabel, DEFAULT_ADB_TCP_PORT };
