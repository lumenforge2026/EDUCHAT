# MDM Test Lab

Painel local para testar os comandos do portal MDM com **tela e logs reais** dos
terminais (via ADB) e criar **bugs no Jira** direto do painel, com a tela e o
log anexados automaticamente.

Roda na sua máquina (não na nuvem) porque precisa falar com os terminais
conectados via ADB e, futuramente, com o broker MQTT real — a sessão do Claude
não alcança sua rede local.

## O que essa primeira versão faz

- Lista os terminais conectados via `adb`, com fabricante, modelo e versão do
  Android detectados automaticamente (`getprop`), e mostra por qual caminho cada
  um entrou: **USB**, **Wi-Fi** ou **Bluetooth**.
- Conecta terminais **sem cabo** direto do painel: Bluetooth (tethering/PAN) ou
  Wi-Fi (`adb tcpip` e pareamento por código do Android 11+) — ver a seção
  "Como conectar os terminais".
- Trabalha com **vários terminais ao mesmo tempo**: limpa o `logcat` de todos
  num clique e abre um único bug no Jira com a evidência de cada um.
- Mostra a tela de cada terminal quase ao vivo (captura via
  `adb exec-out screencap`, atualizada a cada poucos segundos).
- Mostra o `logcat` do terminal, com botão para limpar o log antes de começar
  um teste (assim os logs ficam "do zero" pra aquele teste).
- Cria um **bug no Jira** (projeto `MDM` — Portal MDM) com a tela e o log
  anexados, direto do painel.
- **Comenta num card já existente** no Jira (basta a chave, ex.: `MDM-123`),
  com a opção de anexar a tela e o log atuais do terminal — útil pra registrar
  uma nova reprodução num bug já aberto, sem criar issue duplicada.

A aba de logs filtra o `logcat` pelo processo do app do MDM (`com.mdmservice`,
configurável em `MDM_PACKAGE` no `.env`) — assim ela mostra só o que o próprio
app está logando, e não o log inteiro do Android (encoder de vídeo, gralloc
etc.), que costuma ser 90% do volume num dump bruto. Se o app não estiver
rodando no momento da consulta, o painel avisa e cai pro log geral sem filtro.

**Não está incluído ainda** (fica para uma próxima etapa, se fizer sentido):
integração com o broker MQTT real do `mdm-service` para mostrar o status de
entrega do comando, e correlação automática por `command_id` — hoje o log é
o logcat do processo do app no período do teste, sem esse cruzamento.

## Como conectar os terminais (3 caminhos)

O botão **“+ Conectar dispositivo”** no topo do painel abre os três caminhos.
Em todos eles, o que roda por baixo é o `adb` — o que muda é só por onde ele
trafega. Depois de conectado, tela, logcat e bug no Jira funcionam igual.

### USB (cabo)

O caminho padrão. Conecte, autorize a depuração no aparelho e ele aparece.
É também o único caminho que precisa existir **uma vez** para liberar os
outros dois: no cartão USB, o botão **“Habilitar sem fio”** roda
`adb tcpip 5555` no terminal e mostra os IPs dele por interface (`bt-pan` é a
rede do Bluetooth, `wlan0` é o Wi-Fi), cada um virando um botão de conectar.
Feito isso, o cabo pode sair.

Exceção: terminais Android 11+ podem dispensar essa etapa usando o
pareamento por código (ver Wi-Fi, abaixo).

Dois comportamentos normais depois de "Habilitar sem fio", ambos vistos no
PAX A960 (Android 12):

- O `adb tcpip` reinicia o `adbd`, então o terminal some da lista por alguns
  segundos (ou aparece como "Offline") e volta sozinho.
- Se ele **não** voltar, o suspeito é o **tethering USB** ligado no aparelho:
  com ele ativo, o terminal ocupa a interface USB com a rede (aparece no
  Windows como "Remote NDIS") e o adb deixa de achar o cabo. Desligue em
  Configurações → Ponto de acesso e tethering → Tethering USB.

### Bluetooth (sem cabo)

Um aviso importante para não perder tempo: **o Android não expõe o `adb` por
Bluetooth puro** — não existe transporte adb sobre BT, e nenhum comando
(`shell`, `screencap`, `logcat`) atravessa um pareamento Bluetooth comum.

O que funciona de verdade é o **tethering por Bluetooth (perfil PAN)**: o link
Bluetooth vira uma rede IP (o terminal vira o gateway dela) e o `adb` roda por
cima. Na prática é conexão sem cabo via Bluetooth, com o painel inteiro
funcionando.

O IP do terminal nessa rede não é fixo: até o Android 10 caía quase sempre em
`192.168.44.1`, mas do Android 11 em diante o tethering sorteia a faixa
(confirmado no PAX A960 com `dumpsys tethering`:
`enableLegacyDhcpServer: false`). Por isso o painel não chuta a faixa — ele
descobre o IP pela interface Bluetooth do próprio PC (gateway da rota, endereço
recebido por DHCP e vizinho ARP), e só usa `192.168.44.1` como último recurso.

Passo a passo (o painel automatiza as partes automatizáveis):

1. Pareie o terminal com o PC — o botão **“Abrir Bluetooth do Windows”** abre
   a tela do sistema (o pareamento em si não tem API pública, é do Windows).
2. No terminal: Configurações → Ponto de acesso e tethering → **Tethering por
   Bluetooth**.
3. No Windows: clique no terminal pareado → **Conectar usando → Ponto de
   acesso**. É esse passo que sobe a rede PAN; o painel mostra quando ela
   está no ar em “Verificar Bluetooth do PC”.
4. Uma vez só, por cabo: **“Habilitar sem fio”** (cartão USB).
5. **“Conectar via Bluetooth”** — o painel acha o terminal na rede do PAN e
   roda o `adb connect`.

Se a rede PAN não estiver no ar, o painel avisa na hora em vez de ficar
pendurado no timeout de TCP.

Limite honesto do caminho Bluetooth: a banda do PAN é bem menor que Wi-Fi, e o
polling de screenshot é a parte pesada do painel. Para testes longos com muitos
terminais, Wi-Fi tende a responder melhor; o Bluetooth resolve bem quando não há
Wi-Fi disponível (ou a rede do cliente bloqueia o tráfego entre PC e terminal).

### Wi-Fi (sem cabo)

Terminal e PC na mesma rede. Informe o IP (o **“Habilitar sem fio”** mostra
qual é) e clique em **Conectar**. Em Android 11+ existe também o pareamento por
código: Opções do desenvolvedor → Depuração sem fio → “Parear aparelho com
código” — informe IP, **porta do pareamento** e o código de 6 dígitos no
painel. Atenção: a porta do pareamento não é a mesma da conexão.

Cada card do painel mostra um selo com o caminho usado por aquele terminal
(**USB**, **Wi-Fi** ou **Bluetooth**), então dá pra ver de relance como cada um
entrou. Terminais conectados por rede têm botão **Desconectar**.

## Testando vários terminais de uma vez

Cada card tem um **“Selecionar”**. Com dois ou mais marcados, aparece a barra de
ações em lote:

- **Limpar logs de todos** — zera o `logcat` de todos os selecionados no mesmo
  instante, antes de disparar o comando no portal. Assim o log de todos começa
  “do zero” no mesmo marco.
- **Reportar bug com todos** — cria **uma única** issue no Jira com uma seção
  por terminal (fabricante, modelo, Android e caminho de conexão) e a tela + o
  `logcat` de cada um anexados. É o formato certo para “o comando falhou nesses
  três modelos”.

Terminais que caíram no meio do teste (cabo puxado, PAN derrubado) são ignorados
nas ações em lote, e a barra diz quantos ficaram de fora.

## 1. Pré-requisitos

- **Node.js 18 ou mais recente** instalado na máquina.
- **Android Platform Tools** (o `adb`) instalado e, de preferência, no PATH do
  Windows. Teste abrindo um terminal e rodando `adb version` — se aparecer a
  versão, está pronto. Se não tiver instalado: baixe em
  https://developer.android.com/tools/releases/platform-tools e extraia em
  uma pasta fixa (ex.: `C:\platform-tools`), depois adicione essa pasta ao
  PATH (ou aponte o caminho completo no `.env`, ver abaixo).
- Pelo menos um terminal com **depuração USB habilitada e autorizada** —
  conecte por USB (ou por rede, com `adb tcpip 5555` e depois
  `adb connect <ip>:5555`) e confirme na tela do aparelho a autorização do
  computador. Ele deve aparecer com `adb devices` listando o estado `device`
  (não `unauthorized`).

## 2. Instalação

Dentro da pasta `mdm-test-lab`:

```
npm install
```

Copie o arquivo de exemplo de configuração:

```
copy .env.example .env
```

Abra o `.env` e preencha:

- `ADB_PATH` — deixe `adb` se já estiver no PATH; senão, o caminho completo do
  `adb.exe`.
- `JIRA_BASE_URL` — já vem preenchido com `https://amazonasinovare.atlassian.net`.
- `JIRA_EMAIL` — seu e-mail de login no Jira.
- `JIRA_API_TOKEN` — gere um em
  https://id.atlassian.com/manage-profile/security/api-tokens (não é a sua
  senha do Jira, é um token específico para integrações).
- `JIRA_PROJECT_KEY` — já vem preenchido com `MDM` (projeto "Portal MDM",
  que já tem o tipo de issue "Bug").
- `JIRA_ISSUE_TYPE` — já vem preenchido com `Bug`.

Enquanto o token não estiver preenchido, o painel funciona normalmente para
ver tela e logs — só o botão "Reportar bug" vai mostrar uma mensagem pedindo
pra configurar o `.env`.

## 3. Rodando

```
npm start
```

Abra http://localhost:4545 no navegador (deixe o portal MDM aberto em outra
aba para disparar os comandos de teste).

## 4. Fluxo de uso sugerido

1. Conecte o(s) terminal(is) que vai testar — por cabo, ou sem cabo em
   **"+ Conectar dispositivo"** (Bluetooth/Wi-Fi) — e confirme que aparecem
   como "Conectado" no painel.
2. Abra o dispositivo que vai testar e clique em **"Limpar logs"** na aba
   Logs — isso marca o início do teste. Testando vários de uma vez? Marque
   **"Selecionar"** nos cards e use **"Limpar logs de todos"**.
3. Vá até o portal MDM, dispare o comando.
4. Volte ao painel: acompanhe a tela (aba Tela) e os logs (aba Logs, clique
   em "Atualizar logs") reagindo em tempo quase real.
5. Se algo der errado, vá na aba **"Reportar bug"**, escreva um título e uma
   descrição do que era esperado x o que aconteceu, e clique em
   "Criar bug no Jira". O painel já anexa a tela atual e o log capturado.
   Se o comando falhou em vários terminais, use **"Reportar bug com todos"** na
   barra de seleção — sai uma issue só, com a evidência de cada terminal.
6. Se o bug já existe no Jira (ex.: reproduziu de novo, num terminal
   diferente), vá na aba **"Comentar card"**, informe a chave (ex.: `MDM-123`)
   e o comentário — o painel anexa a tela e o log atuais ao comentário. Pra
   comentar com vários terminais de uma vez, use "Reportar bug com todos" na
   barra de seleção e role até "Ou comentar num card já existente".

## Estrutura

```
mdm-test-lab/
  server.js          → backend Express (chama adb e a API do Jira)
  transports.js      → conexão sem cabo: Bluetooth (PAN) e Wi-Fi
  public/index.html  → painel (frontend, tudo num arquivo)
  package.json
  .env.example
```

Nenhum arquivo do projeto `mdm-service` foi tocado — esta é uma ferramenta
separada, pensada para rodar ao lado dele.

## Próximos passos possíveis

- Plugar no broker MQTT real (`mdm-mqtt-vmq`) para mostrar o status de entrega
  do comando e correlacionar automaticamente por `command_id`.
- Aproveitar o módulo `mdm-telemetry` como fonte de status em vez (ou além) do
  logcat cru.
- Trocar o polling de screenshot por espelhamento via `scrcpy` para uma
  experiência mais fluida em testes longos (ajuda especialmente no caminho
  Bluetooth, onde a banda do PAN é o gargalo).
- Disparar o mesmo comando do portal para vários terminais direto do painel
  (hoje o disparo continua sendo no portal; o painel cobre a evidência).
