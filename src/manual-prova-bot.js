import { firefox } from 'playwright';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const USER_DATA_DIR = path.resolve('.browser-profile');
const OUTPUT_FILE = path.resolve('leitura-prova.json');
const PROMPT_FILE = path.resolve('prompt-prova.txt');
const ANSWERS_TEXT_FILE = path.resolve('respostas.txt');
const CHATGPT_PAGE_TEXT_FILE = path.resolve('chatgpt-pagina.txt');
const USER_ENV_FILES = [path.resolve('user.env'), path.resolve('..', 'user.env')];
const DEFAULT_SITE_URL = 'https://estudante.estacio.br/disciplinas';
const EVALUATIONS_URL = 'https://estudante.estacio.br/avaliacoes';
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VALID_LETTERS = new Set(['A', 'B', 'C', 'D', 'E']);

const rl = readline.createInterface({ input, output });

let lastRead = null;

const context = await firefox.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  viewport: { width: 1366, height: 768 },
});

const page = context.pages()[0] ?? await context.newPage();
page.setDefaultTimeout(5000);

await openUrl(DEFAULT_SITE_URL);
await collectEvaluationsIfLoggedIn();
printBanner();

try {
  while (true) {
    const line = (await askPrompt()).trim();
    if (!line) continue;

    const [commandRaw, ...args] = line.split(/\s+/);
    const command = commandRaw.toLowerCase();

    if (['sair', 'exit', 'quit'].includes(command)) break;
    if (['ajuda', 'help', '?'].includes(command)) {
      printHelp();
      continue;
    }

    try {
      if (command === 'abrir') await openUrl(args.join(' '));
      else if (command === 'site') await openUrl(args[0] ? buildExamUrl(args[0]) : DEFAULT_SITE_URL);
      else if (command === 'avaliacoes') await collectEvaluations();
      else if (command === 'prova') await openUrl(buildExamUrl(args[0] ?? ''));
      else if (command === 'ler') await readVisibleExam();
      else if (command === 'prompt') await savePromptForChat();
      else if (command === 'aplicar' || command === 'respostas') await applyAnswerList(args);
      else if (command === 'salvar') await saveLastRead();
      else if (command === 'marcar') await markOption(args);
      else if (command === 'scroll') await scrollPage(args[0]);
      else if (command === 'ir') await goToQuestion(args[0]);
      else console.log('Comando desconhecido. Digite "ajuda" para ver as opcoes.');
    } catch (error) {
      console.log(`Nao consegui executar isso: ${error.message}`);
    }
  }
} finally {
  rl.close();
  await context.close();
}

async function askPrompt() {
  try {
    return await rl.question('\nprova> ');
  } catch (error) {
    if (error?.code === 'ERR_USE_AFTER_CLOSE') return 'sair';
    throw error;
  }
}

function printBanner() {
  console.log('Assistente de prova aberto.');
  console.log('Use apenas em provas suas ou ambientes em que voce tenha autorizacao.');
  printHelp();
}

function printHelp() {
  console.log(`
Comandos:
  site              Abre https://estudante.estacio.br/disciplinas
  avaliacoes        Abre avaliacoes e acessa a primeira prova
  site <chave>      Abre https://estacio.saladeavaliacoes.com.br/prova/<chave>/
  prova <chave>     Abre https://estacio.saladeavaliacoes.com.br/prova/<chave>/
  abrir <url>       Abre uma URL completa
  ler               Le titulo, questoes e alternativas visiveis
  prompt            Substitui prompt-prova.txt, cola no ChatGPT e tenta ler respostas
  aplicar           Le respostas.txt e marca alternativas
  aplicar A B C...  Marca letras informadas na ordem
  aplicar 1:A 2:B   Marca respostas por questao
  marcar 1 C        Clica na alternativa C da questao 1
  scroll baixo      Rola para baixo
  scroll cima       Rola para cima
  ir 5              Tenta abrir a questao 5 pelo menu lateral
  salvar            Salva a ultima leitura em leitura-prova.json
  sair              Fecha o navegador
`);
}

function buildExamUrl(keyOrUrl) {
  if (/^https?:\/\//i.test(keyOrUrl)) return keyOrUrl;
  const key = keyOrUrl.replace(/^\/+|\/+$/g, '');
  if (!key) throw new Error('informe a chave da prova. Exemplo: prova 69f3...');
  return `https://estacio.saladeavaliacoes.com.br/prova/${key}/`;
}

async function openUrl(rawUrl) {
  if (!rawUrl) throw new Error('informe uma URL');
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  if (page.url().includes('estudante.estacio.br') && await waitForLoggedInEstacio(12000)) {
    console.log(`Aberto: ${url}`);
    return;
  }

  const loginButton = await waitForAnyVisible([
    'button.sc-dJGLCP.jPzwMQ',
    'button:has-text("Entrar")',
    '[role="button"]:has-text("Entrar")',
  ], 1000);
  if (!loginButton) {
    console.log(`Aberto: ${url}`);
    return;
  }

  await clickEstacioLoginButtonIfVisible();
  await fillUserEstacioIfVisible();
  console.log(`Aberto: ${url}`);
}

async function isLoggedInEstacio() {
  if (!page.url().includes('estudante.estacio.br')) return false;
  const pageText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  return /Cursando:|Meu curso|Secretaria digital|Minha Carreira|Minhas Disciplinas/i.test(pageText);
}

async function waitForLoggedInEstacio(totalTimeoutMs) {
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    if (await isLoggedInEstacio()) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function clickEstacioLoginButtonIfVisible() {
  const selectors = [
    'button.sc-dJGLCP.jPzwMQ',
    'button:has-text("Entrar")',
    '[role="button"]:has-text("Entrar")',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: 2500 });
      await locator.click();
      console.log('Tela de login detectada: cliquei em Entrar.');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1000);
      await fillUserEstacioIfVisible();
      await page.waitForTimeout(2000);
      await fillUserEstacioIfVisible();
      return;
    } catch {
      // Tenta o proximo seletor.
    }
  }
}

async function fillUserEstacioIfVisible() {
  const userEstacio = await readUserEstacio();
  if (!userEstacio) return;

  const inputSelectors = [
    '.form-control.ltr_override.input.ext-input.text-box.ext-text-box',
    'input.form-control.ltr_override.input.ext-input.text-box.ext-text-box',
    'input[type="email"]',
    'input[name="loginfmt"]',
    'input#i0116',
    'input[name="email"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
  ];

  let filled = false;
  for (const selector of inputSelectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: 4000 });
      await locator.fill(userEstacio);
      filled = true;
      console.log('Tela de confirmacao de e-mail detectada: preenchi user_estacio.');
      break;
    } catch {
      // Tenta o proximo seletor.
    }
  }

  if (!filled) return;

  const buttonSelectors = [
    '.win-button.button_primary.high-contrast-overrides.button.ext-button.primary.ext-primary',
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Avançar")',
    'button:has-text("Continuar")',
    'button:has-text("Entrar")',
    'button:has-text("Next")',
  ];

  for (const selector of buttonSelectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: 3000 });
      await locator.click();
      console.log('Cliquei no botao primario da confirmacao de e-mail.');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1000);
      await fillPasswordEstacioIfVisible();
      return;
    } catch {
      // Tenta o proximo seletor.
    }
  }
}

async function readUserEstacio() {
  const userEnvFile = USER_ENV_FILES.find((filePath) => existsSync(filePath));
  if (!userEnvFile) {
    console.log('Arquivo user.env nao encontrado em Prova nem em GitHub; nao preenchi user_estacio.');
    return '';
  }

  const envText = await readFile(userEnvFile, 'utf8');
  const values = parseEnvText(envText);
  const userEstacio = values.user_estacio || values.USER_ESTACIO || values.email_estacio || values.EMAIL_ESTACIO;
  if (!userEstacio) {
    console.log(`user.env encontrado em ${userEnvFile}, mas sem user_estacio.`);
    return '';
  }

  return userEstacio;
}

async function fillPasswordEstacioIfVisible() {
  const passwordEstacio = await readPasswordEstacio();
  if (!passwordEstacio) return;

  const passwordSelectors = [
    '.form-control.input.ext-input.text-box.ext-text-box.show-reveal-password.ext-show-reveal-password.has-error.ext-has-error',
    'input.form-control.input.ext-input.text-box.ext-text-box.show-reveal-password.ext-show-reveal-password.has-error.ext-has-error',
    'input[type="password"]',
    'input[name="passwd"]',
    'input#i0118',
  ];

  const passwordInput = await waitForAnyVisible(passwordSelectors, 20000);
  if (!passwordInput) return;

  await passwordInput.fill(passwordEstacio);
  console.log('Campo de senha detectado: preenchi password_estacio automaticamente.');

  const buttonSelectors = [
    '.win-button.button_primary.high-contrast-overrides.button.ext-button.primary.ext-primary',
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Entrar")',
    'button:has-text("Sign in")',
    'button:has-text("Next")',
  ];

  for (const selector of buttonSelectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: 3000 });
      await locator.click();
      console.log('Cliquei no botao primario da senha.');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1500);
      return;
    } catch {
      // Tenta o proximo seletor.
    }
  }
}

async function waitForAnyVisible(selectors, totalTimeoutMs) {
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout: 500 })) return locator;
      } catch {
        // Tenta o proximo seletor.
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function clickLoggedInMenuIfVisible() {
  if (!page.url().includes('estudante.estacio.br/disciplinas')) return;

  const selectors = [
    '.menu',
    '[class~="menu"]',
    'button.menu',
    '[aria-label*="menu" i]',
    '[aria-label*="Menu" i]',
  ];

  const menu = await waitForAnyVisible(selectors, 8000);
  if (!menu) return;

  try {
    await menu.click();
    console.log('Usuario logado detectado: cliquei no menu.');
    await page.waitForTimeout(500);
  } catch {
    // Se o clique falhar, apenas segue com a pagina aberta.
  }
}

async function readPasswordEstacio() {
  const userEnvFile = USER_ENV_FILES.find((filePath) => existsSync(filePath));
  if (!userEnvFile) {
    console.log('Arquivo user.env nao encontrado em Prova nem em GitHub; nao preenchi password_estacio.');
    return '';
  }

  const envText = await readFile(userEnvFile, 'utf8');
  const values = parseEnvText(envText);
  const passwordEstacio = values.password_estacio || values.PASSWORD_ESTACIO;
  if (!passwordEstacio) {
    console.log(`user.env encontrado em ${userEnvFile}, mas sem password_estacio.`);
    return '';
  }

  return passwordEstacio;
}

function parseEnvText(envText) {
  const values = {};
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
}

async function readVisibleExam() {
  lastRead = await collectExam();
  printReadSummary(lastRead);

  if (lastRead.questions.length === 0) {
    console.log('Nao encontrei questoes visiveis. Role a pagina ou confira se a prova esta aberta.');
    return;
  }

  for (const question of lastRead.questions) {
    console.log(`\nQuestao ${question.number ?? '?'}: ${question.statement}`);
    for (const option of question.options) console.log(`  ${option.letter}) ${option.text}`);
  }
}

async function oldCollectEvaluations() {
  await openUrl(EVALUATIONS_URL);
  await page.waitForFunction(() => document.body?.innerText?.includes('Minhas Disciplinas'), null, { timeout: 45000 });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const titles = [...document.querySelectorAll('[role="heading"]')]
      .map((element) => clean(element.innerText || element.textContent))
      .filter((title) => title && !/Avaliações|Cursando|CIÊNCIA|Ciência|Gabriel|GE/i.test(title));
    const btnAcessarAvaliacoes = document.querySelectorAll('.btn-acessar-avaliacoes').length;

    return {
      url: location.href,
      btnAcessarAvaliacoes,
      count: titles.length,
      titles,
    };
  });

  await page.screenshot({ path: EVALUATIONS_SCREENSHOT, fullPage: true });
  await writeFile(EVALUATIONS_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

  console.log(`Provas pendentes detectadas: ${data.count}`);
  for (const [index, title] of data.titles.entries()) {
    console.log(`${index + 1}. ${title}`);
  }
  console.log(`Print salvo em ${EVALUATIONS_SCREENSHOT}`);
  console.log(`Resultado salvo em ${EVALUATIONS_FILE}`);
}

async function oldCollectEvaluationsIfLoggedIn() {
  if (!page.url().includes('estudante.estacio.br/disciplinas')) return;
  if (!(await isLoggedInEstacio())) return;

  console.log('Usuario logado detectado em disciplinas. Vou abrir avaliacoes e listar provas pendentes.');
  await collectEvaluations();
}

async function collectExam() {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(400);

  const firstRead = await scrapeCurrentPage();
  const firstCount = firstRead.questions.length;

  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(250);
  }

  const fullRead = await scrapeCurrentPage();
  const bestRead = fullRead.questions.length >= firstCount ? fullRead : firstRead;
  bestRead.questions = dedupeQuestions(bestRead.questions).slice(0, 10);
  return bestRead;
}

async function scrapeCurrentPage() {
  return page.evaluate(`(() => {
    ${browserHelpersSource()}
    return scrapeVisibleExam();
  })()`);
}

function dedupeQuestions(questions) {
  const byKey = new Map();
  for (const question of questions) {
    const key = question.number ?? question.statement.slice(0, 80);
    const existing = byKey.get(key);
    if (!existing || question.options.length > existing.options.length) byKey.set(key, question);
  }
  return [...byKey.values()].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
}

async function saveLastRead() {
  if (!lastRead) throw new Error('nada para salvar ainda. Use "ler" primeiro.');
  await writeFile(OUTPUT_FILE, `${JSON.stringify(lastRead, null, 2)}\n`, 'utf8');
  console.log(`Leitura salva em ${OUTPUT_FILE}`);
}

async function savePromptForChat() {
  lastRead = await collectExam();
  printReadSummary(lastRead);

  const prompt = [
    'Resolva esta prova em portugues do Brasil.',
    'Escolha exatamente uma alternativa por questao.',
    'Comece sua resposta com uma linha no formato: RESPOSTAS: A B C D E A B C D E',
    'Use somente letras A, B, C, D ou E nessa linha de respostas.',
    'Depois, se quiser, inclua uma justificativa curta por questao.',
    '',
    buildAnswerPrompt(lastRead),
  ].join('\n');

  await writeFile(PROMPT_FILE, prompt, 'utf8');
  console.log(`Prompt salvo/substituido em ${PROMPT_FILE}`);
  await copyTextToClipboard(prompt);
  console.log('Prompt copiado para a area de transferencia.');

  const chatText = await openChatGptInChrome();
  if (chatText) {
    await writeFile(CHATGPT_PAGE_TEXT_FILE, chatText, 'utf8');
    const parsed = extractAnswersFromChatText(chatText);
    if (parsed.length > 0) {
      await writeFile(ANSWERS_TEXT_FILE, `${formatAnswers(parsed)}\n`, 'utf8');
      console.log(`Respostas detectadas e salvas em ${ANSWERS_TEXT_FILE}`);
      await applyParsedAnswers(parsed);
    } else {
      console.log(`Texto salvo em ${CHATGPT_PAGE_TEXT_FILE}, mas nao encontrei sequencia de respostas.`);
    }
  }

  console.log('Revise a tela antes de finalizar a prova manualmente.');
}

async function openChatGptInChrome() {
  if (!existsSync(CHROME_EXE)) {
    console.log(`Nao encontrei Chrome em ${CHROME_EXE}. O prompt ja esta copiado.`);
    return '';
  }

  const child = spawn(CHROME_EXE, ['https://chatgpt.com/'], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('ChatGPT aberto no Chrome normal. Vou tentar colar, enviar e copiar a resposta.');
  return pasteSendAndCopyChat();
}

async function pasteSendAndCopyChat() {
  if (process.platform !== 'win32') {
    console.log('Cole manualmente com Ctrl+V.');
    return '';
  }

  const sendScript = `
    Start-Sleep -Milliseconds 3500
    $shell = New-Object -ComObject WScript.Shell
    $chrome = Get-Process chrome -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Sort-Object @{ Expression = { if ($_.MainWindowTitle -match 'ChatGPT') { 0 } else { 1 } } }, StartTime -Descending |
      Select-Object -First 1
    if (-not $chrome) { exit 2 }
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WindowFocus {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
    Get-Process firefox -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      ForEach-Object { [WindowFocus]::ShowWindowAsync($_.MainWindowHandle, 6) | Out-Null }
    Start-Sleep -Milliseconds 300
    [WindowFocus]::ShowWindowAsync($chrome.MainWindowHandle, 9) | Out-Null
    [WindowFocus]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 500
    $activated = $shell.AppActivate([int]$chrome.Id)
    if (-not $activated) { exit 2 }
    Start-Sleep -Milliseconds 300
    $foreground = [WindowFocus]::GetForegroundWindow()
    $foregroundPid = 0
    [WindowFocus]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) | Out-Null
    if ($foregroundPid -ne $chrome.Id) {
      $shell.SendKeys('%{TAB}')
      Start-Sleep -Milliseconds 700
    }
    $shell.SendKeys('^t')
    Start-Sleep -Milliseconds 500
    $shell.SendKeys('https://chatgpt.com/')
    Start-Sleep -Milliseconds 300
    $shell.SendKeys('{ENTER}')
    Start-Sleep -Milliseconds 4500
    Start-Sleep -Milliseconds 500
    $shell.SendKeys('^v')
    Start-Sleep -Milliseconds 10000
    $shell.SendKeys('{ENTER}')
  `;

  try {
    await runPowerShell(sendScript);
    console.log('Colei, aguardei 10s e enviei no ChatGPT. Vou aguardar a linha RESPOSTAS.');
  } catch {
    console.log('Nao consegui focar o Chrome. O prompt ja esta copiado; cole manualmente.');
    return '';
  }

  let lastCopiedText = '';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await page.waitForTimeout(2000);
    lastCopiedText = await copyChromePageText().catch(() => '');
    if (extractAnswersFromChatText(lastCopiedText).length > 0) {
      console.log(`Resposta do ChatGPT encontrada na tentativa ${attempt}.`);
      return lastCopiedText;
    }
  }

  console.log('Copiei o texto da pagina, mas ainda nao encontrei uma linha RESPOSTAS valida.');
  return lastCopiedText;
}

async function copyChromePageText() {
  const script = `
    $shell = New-Object -ComObject WScript.Shell
    $chrome = Get-Process chrome -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Sort-Object @{ Expression = { if ($_.MainWindowTitle -match 'ChatGPT') { 0 } else { 1 } } }, StartTime -Descending |
      Select-Object -First 1
    if (-not $chrome) { exit 2 }
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WindowFocus {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
    Get-Process firefox -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      ForEach-Object { [WindowFocus]::ShowWindowAsync($_.MainWindowHandle, 6) | Out-Null }
    Start-Sleep -Milliseconds 300
    [WindowFocus]::ShowWindowAsync($chrome.MainWindowHandle, 9) | Out-Null
    [WindowFocus]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 500
    $activated = $shell.AppActivate([int]$chrome.Id)
    if (-not $activated) { exit 2 }
    Start-Sleep -Milliseconds 300
    $foreground = [WindowFocus]::GetForegroundWindow()
    $foregroundPid = 0
    [WindowFocus]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) | Out-Null
    if ($foregroundPid -ne $chrome.Id) {
      $shell.SendKeys('%{TAB}')
      Start-Sleep -Milliseconds 700
    }
    Start-Sleep -Milliseconds 300
    $shell.SendKeys('{ESC}')
    Start-Sleep -Milliseconds 300
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseClicker {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);
}
"@
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $x = [int]($bounds.Width * 0.55)
    $y = [int]($bounds.Height * 0.45)
    [MouseClicker]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 100
    [MouseClicker]::mouse_event(2, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 50
    [MouseClicker]::mouse_event(4, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 300
    $shell.SendKeys('^a')
    Start-Sleep -Milliseconds 300
    $shell.SendKeys('^c')
    Start-Sleep -Milliseconds 500
    Get-Clipboard -Raw
  `;
  return runPowerShell(script);
}

async function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `PowerShell saiu com codigo ${code}`));
    });
  });
}

async function applyAnswerList(args) {
  const rawAnswers = await readAnswerInput(args);
  lastRead = await collectExam();
  const questions = dedupeQuestions(lastRead.questions).slice(0, 10);
  const answers = parseAnswerArgs(rawAnswers, questions);
  await applyParsedAnswers(answers);
}

async function applyParsedAnswers(answers) {
  if (!answers.length) throw new Error('nao encontrei respostas para marcar');

  await focusExamBrowserWindow();
  await page.bringToFront().catch(() => {});
  lastRead = await collectExam();
  console.log(`Vou marcar automaticamente: ${answers.map((answer) => answer.letter).join(' ')}`);

  for (const answer of answers) {
    const result = await markAnswerAndConfirm(answer.questionNumber, answer.letter);

    if (result.ok) console.log(`Marcada: questao ${answer.questionNumber}, alternativa ${answer.letter}.`);
    else console.log(`Nao marcou questao ${answer.questionNumber}: ${result.reason}`);
  }

  if (answers.length < 10) {
    console.log('Nao finalizei porque detectei menos de 10 respostas.');
    return;
  }

  const answeredCount = await getAnsweredCount();
  if (answeredCount < 10) {
    console.log(`Nao finalizei porque o painel ainda mostra Respondidas (${answeredCount}).`);
    return;
  }

  await finishExamWithToken();
}

async function markAnswerAndConfirm(questionNumber, letter) {
  const before = await getAnsweredCount();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await clickAnswerWithLocators(questionNumber, letter);
    await page.waitForTimeout(700);
    const after = await getAnsweredCount();
    const checked = await isQuestionAnswered(questionNumber);

    if (result.ok && (checked || after > before || after >= questionNumber)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: `cliquei na alternativa ${letter}, mas a questao ${questionNumber} nao confirmou resposta` };
}

async function clickAnswerWithLocators(questionNumber, letter) {
  const question = page.locator(`[data-testid="question-${questionNumber}"]`).first();
  if (await question.count().catch(() => 0)) {
    await question.scrollIntoViewIfNeeded().catch(() => {});

    const locators = [
      question.locator(`input[type="radio"][value="${letter}"]`).first(),
      question.locator(`input[type="radio"][aria-label="${letter}"]`).first(),
      question.locator(`[role="radio"][aria-label="${letter}"]`).first(),
      question.getByText(new RegExp(`^\\s*${letter}\\s*$`, 'i')).first(),
    ];

    for (const locator of locators) {
      if (!(await locator.count().catch(() => 0))) continue;
      try {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        await locator.check({ force: true, timeout: 1000 }).catch(async () => {
          await locator.click({ force: true, timeout: 1000 });
        });
        return { ok: true };
      } catch {
        // Tenta o proximo locator.
      }
    }
  }

  const fallback = await page.evaluate(`(() => {
    ${browserHelpersSource()}
    return clickOptionByQuestionAndLetter(${questionNumber}, ${JSON.stringify(letter)});
  })()`);
  return fallback;
}

async function getAnsweredCount() {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const match = text.match(/Respondidas\s*\((\d+)\)/i);
    return match ? Number(match[1]) : 0;
  }).catch(() => 0);
}

async function isQuestionAnswered(questionNumber) {
  return page.evaluate((target) => {
    const root = document.querySelector(`[data-testid="question-${target}"]`);
    if (!root) return false;
    const checkedInput = root.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked');
    if (checkedInput) return true;
    const selected = [...root.querySelectorAll('[aria-checked="true"], [aria-selected="true"], [data-state="checked"], [data-checked="true"]')];
    return selected.length > 0;
  }, questionNumber).catch(() => false);
}

async function finishExamWithToken() {
  await focusExamBrowserWindow();
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(800);

  const finishButton = await waitForAnyVisible([
    '[data-element="button_finalizar-prova"]',
    'button[aria-label="Finalizar prova"]',
    'button:has-text("Finalizar prova")',
    '[role="button"]:has-text("Finalizar prova")',
  ], 15000);

  if (!finishButton) {
    console.log('Respostas marcadas, mas nao encontrei o botao Finalizar prova.');
    return;
  }

  await finishButton.click();
  await page.waitForTimeout(1000);

  const token = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const match = text.match(/(?:Seu\s+c[oó]digo\s*(?:[eé]|:)?|c[oó]digo\s*(?:[eé]|:))\s*:?[\s\n]*(\d{4,8})/i);
    return match?.[1] || '';
  }).catch(() => '');

  if (!token) {
    console.log('Cliquei em Finalizar prova, mas nao encontrei o token no modal.');
    return;
  }

  const tokenInput = await waitForAnyVisible([
    '[data-testid="exam-end-modal-input"]',
    'input[data-lift="lft-input-text"][name="InputText"]',
    'input#InputText',
    'input[placeholder="Insira o seu código aqui"]',
    'input[placeholder="Insira o seu codigo aqui"]',
  ], 15000);

  if (!tokenInput) {
    console.log(`Token encontrado (${token}), mas nao encontrei o campo para preencher.`);
    return;
  }

  await tokenInput.fill(token);
  await page.waitForTimeout(800);

  const modalEndButton = await waitForAnyVisible([
    '[data-testid="exam-end-modal-end-button"]',
    'button[data-testid="exam-end-modal-end-button"]',
    'button[data-element="button_finalizar-prova"][data-testid="exam-end-modal-end-button"]',
    'button.css-1ujby1e:has-text("Finalizar prova")',
  ], 10000);

  let clicked = false;
  if (modalEndButton) {
    await modalEndButton.click({ force: true }).catch(() => {});
    clicked = true;
  }

  clicked = clicked || await page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const isEnabled = (element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(isVisible)
      .filter(isEnabled)
      .filter((element) => /^Finalizar prova$/i.test(clean(element.innerText || element.textContent)));
    const button = buttons.at(-1);
    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  });

  if (!clicked) {
    console.log(`Preenchi o token ${token}, mas nao encontrei o botao final habilitado.`);
    return;
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  console.log(`Prova finalizada com token ${token}.`);
}

async function focusExamBrowserWindow() {
  if (process.platform !== 'win32') return;

  const script = `
    $shell = New-Object -ComObject WScript.Shell
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WindowFocus {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
    $firefox = Get-Process firefox -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Select-Object -First 1
    if ($firefox) {
      [WindowFocus]::ShowWindowAsync($firefox.MainWindowHandle, 9) | Out-Null
      [WindowFocus]::SetForegroundWindow($firefox.MainWindowHandle) | Out-Null
      $shell.AppActivate([int]$firefox.Id) | Out-Null
    }
    Start-Sleep -Milliseconds 500
  `;
  await runPowerShell(script).catch(() => {});
}

async function readAnswerInput(args) {
  if (args.length === 0) {
    if (existsSync(ANSWERS_TEXT_FILE)) return readFile(ANSWERS_TEXT_FILE, 'utf8');
    if (existsSync(PROMPT_FILE)) {
      const prompt = await readFile(PROMPT_FILE, 'utf8');
      await copyTextToClipboard(prompt);
      throw new Error('respostas.txt ainda nao existe. Copiei prompt-prova.txt para a area de transferencia.');
    }
    throw new Error('nao encontrei respostas.txt nem prompt-prova.txt. Use "prompt" primeiro.');
  }

  if (args.length === 1 && /\.txt$/i.test(args[0])) return readFile(path.resolve(args[0]), 'utf8');
  return args.join(' ');
}

async function copyTextToClipboard(text) {
  const command = process.platform === 'win32' ? 'clip.exe' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
  const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : [];

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`nao consegui copiar para a area de transferencia: ${stderr || command}`));
    });
    child.stdin.end(text);
  });
}

function extractAnswersFromChatText(text) {
  const normalized = text.toUpperCase().replace(/\r/g, '\n');
  const explicit = [...normalized.matchAll(/\b(\d{1,2})\s*[-:=]\s*([A-E])\b/g)]
    .map((match) => ({ questionNumber: Number(match[1]), letter: match[2] }))
    .filter((answer) => answer.questionNumber >= 1 && answer.questionNumber <= 10);

  if (explicit.length > 0) {
    const byQuestion = new Map();
    for (const answer of explicit) byQuestion.set(answer.questionNumber, answer.letter);
    if (byQuestion.size === 10) {
      return [...byQuestion.entries()].sort(([a], [b]) => a - b).map(([questionNumber, letter]) => ({ questionNumber, letter }));
    }
  }

  const isPromptExample = (match) => {
    const before = normalized.slice(Math.max(0, match.index - 80), match.index);
    const sequence = (match[1] || '').trim();
    return /FORMATO|EXEMPLO|COMO|QUANDO|ENTENDEU|INTERPRETA|COMECE SUA RESPOSTA/i.test(before) || sequence === 'A B C D E A B C D E';
  };

  const marked = [...normalized.matchAll(/\b(?:RESPOSTAS|RESPOSTA FINAL|GABARITO)\s*[:=-]?\s*((?:[A-E]\s+){9}[A-E])\b/g)]
    .filter((match) => !isPromptExample(match));
  const sequences = marked.length > 0
    ? marked
    : [...normalized.matchAll(/\b([A-E](?:\s+[A-E]){9})\b/g)].filter((match) => !isPromptExample(match));
  if (sequences.length === 0) return [];

  return sequences.at(-1)[1].split(/\s+/).map((letter, index) => ({ questionNumber: index + 1, letter }));
}

function formatAnswers(answers) {
  return answers.map((answer) => `${answer.questionNumber}-${answer.letter}`).join('\n');
}

function parseAnswerArgs(rawAnswers, questions) {
  const joined = rawAnswers.toUpperCase();
  const explicit = [...joined.matchAll(/(\d{1,2})\s*[:=-]\s*([A-E])/g)].map((match) => ({
    questionNumber: Number(match[1]),
    letter: match[2],
  }));
  if (explicit.length > 0) return explicit;

  const letters = joined.match(/[A-E]/g) ?? [];
  if (letters.length === 0) throw new Error('nao encontrei letras entre A e E. Exemplo: aplicar A B C D E');
  if (letters.length > questions.length) throw new Error(`voce informou ${letters.length} letras, mas detectei ${questions.length} questoes`);
  return letters.map((letter, index) => ({ questionNumber: questions[index]?.number ?? index + 1, letter }));
}

function printReadSummary(read) {
  console.log(`\nTitulo: ${read.title || '(nao detectado)'}`);
  console.log(`Questoes detectadas: ${read.questions.length}`);
}

function buildAnswerPrompt(read) {
  const questions = read.questions.map((question) => ({
    questionNumber: question.number,
    statement: question.statement,
    options: question.options,
  }));
  return JSON.stringify(
    {
      title: read.title,
      totalQuestionsDetected: read.questions.length,
      questions,
      responseRules: {
        answers: 'Uma resposta por questao detectada.',
        reason: 'Justificativa curta, no maximo uma frase.',
      },
    },
    null,
    2,
  );
}

async function markOption(args) {
  const number = Number.parseInt(args[0], 10);
  const letter = (args[1] ?? '').toUpperCase();
  if (!Number.isInteger(number) || number < 1) throw new Error('informe o numero da questao. Exemplo: marcar 1 C');
  if (!VALID_LETTERS.has(letter)) throw new Error('informe uma letra entre A e E. Exemplo: marcar 1 C');

  const result = await page.evaluate(`(() => {
    ${browserHelpersSource()}
    return clickOptionByQuestionAndLetter(${number}, ${JSON.stringify(letter)});
  })()`);
  if (!result.ok) throw new Error(result.reason);
  console.log(`Clique executado: questao ${number}, alternativa ${letter}.`);
}

async function scrollPage(direction = 'baixo') {
  const amount = ['cima', 'up'].includes((direction ?? '').toLowerCase()) ? -650 : 650;
  await page.mouse.wheel(0, amount);
  await page.waitForTimeout(250);
  console.log(amount > 0 ? 'Rolei para baixo.' : 'Rolei para cima.');
}

async function goToQuestion(rawNumber) {
  const number = Number.parseInt(rawNumber, 10);
  if (!Number.isInteger(number) || number < 1) throw new Error('informe o numero da questao. Exemplo: ir 5');

  const clicked = await page.evaluate((target) => {
    const candidates = [...document.querySelectorAll('button, [role="button"], a')];
    const button = candidates.find((element) => visible(element) && textOf(element) === String(target));
    if (!button) return false;
    button.click();
    return true;
  }, number);
  console.log(clicked ? `Tentei abrir a questao ${number}.` : `Nao encontrei botao de navegacao para a questao ${number}.`);
}

function browserHelpersSource() {
  return [
    scrapeVisibleExam,
    clickOptionByQuestionAndLetter,
    clickOptionByQuestionTestId,
    findQuestionRoots,
    findOptionRoot,
    climbToOptionContainer,
    nearestSiblingText,
    cleanInlineText,
    textOf,
    visible,
  ].map((helper) => helper.toString()).join('\n');
}

function scrapeVisibleExam() {
  const title = detectTitle();
  const questionRoots = findQuestionRoots();
  const questions = questionRoots.map(parseQuestionRoot).filter(Boolean);
  return { title, capturedAt: new Date().toISOString(), url: location.href, questions };

  function detectTitle() {
    const explicitTitle = [...document.querySelectorAll('.css-1qsp6bi')]
      .map(textOf)
      .find((text) => text && /[A-Za-z\u00c0-\u00ff]/.test(text) && text.length <= 120);
    if (explicitTitle) return explicitTitle;

    const headerText = [...document.querySelectorAll('header, [class*="header"], [class*="top"], nav')]
      .map(textOf)
      .find((text) => text && /[A-Za-z\u00c0-\u00ff]/.test(text));
    if (!headerText) return document.title || '';

    const parts = headerText.split(/\n+/).map((part) => part.trim()).filter(Boolean).filter((part) => !/^[A-Z]{1,3}\d+$/i.test(part));
    return parts.length > 0 ? parts.join(' | ') : document.title || '';
  }

  function parseQuestionRoot(root) {
    const allText = textOf(root);
    const number = detectQuestionNumber(root, allText);
    const options = detectOptions(root);
    const statement = detectStatement(root, options);
    if (!statement && options.length === 0) return null;
    return { number, statement, options };
  }

  function detectQuestionNumber(root, allText) {
    const aria = root.getAttribute('aria-label') || '';
    const ariaMatch = aria.match(/quest(?:a|\u00e3)o\s*(\d+)/i);
    if (ariaMatch) return Number(ariaMatch[1]);
    const textMatch = allText.match(/(?:^|\n)\s*(\d{1,2})\s*(?:\n|$)/);
    return textMatch ? Number(textMatch[1]) : null;
  }

  function detectOptions(root) {
    const optionMap = new Map();
    for (const letter of ['A', 'B', 'C', 'D', 'E']) {
      const optionRoot = findOptionRoot(root, letter);
      if (!optionRoot) continue;
      let text = textOf(optionRoot).replace(new RegExp(`^${letter}\\s*\\n?\\s*`, 'i'), '').trim();
      if (!text || text.length < 2) text = nearestSiblingText(optionRoot, letter);
      if (text) optionMap.set(letter, cleanInlineText(text));
    }
    return [...optionMap.entries()].map(([letter, text]) => ({ letter, text }));
  }

  function detectStatement(root, options) {
    const text = textOf(root);
    const optionLettersPattern = options.map((option) => option.letter).join('|') || 'A|B|C|D|E';
    const firstOptionMatch = text.match(new RegExp(`\\n\\s*(${optionLettersPattern})\\s*\\n`, 'i'));
    const beforeOptions = firstOptionMatch ? text.slice(0, firstOptionMatch.index) : text;
    return cleanInlineText(beforeOptions.replace(/^\s*\d{1,2}\s*/m, '').replace(/marcar para revis(?:a|\u00e3)o/gi, '').trim());
  }
}

function findQuestionRoots() {
  const reviewButtons = [...document.querySelectorAll('button, [role="button"]')].filter((element) => /marcar para revis(?:a|\u00e3)o/i.test(textOf(element)));
  const roots = [];
  for (const button of reviewButtons) {
    let best = null;
    for (let element = button.parentElement; element && element !== document.body; element = element.parentElement) {
      const text = textOf(element);
      if (/marcar para revis(?:a|\u00e3)o/i.test(text) && /\bA\b/.test(text) && /\bB\b/.test(text) && /\bC\b/.test(text) && text.length > 120) {
        best = element;
        break;
      }
    }
    if (best && !roots.includes(best)) roots.push(best);
  }
  return roots.filter(visible);
}

function clickOptionByQuestionAndLetter(number, letter) {
  const byTestId = clickOptionByQuestionTestId(number, letter);
  if (byTestId.ok) return byTestId;

  const roots = findQuestionRoots();
  const root = roots.find((candidate, index) => {
    const match = textOf(candidate).match(/(?:^|\n)\s*(\d{1,2})\s*(?:\n|$)/);
    const parsed = match ? Number(match[1]) : null;
    return parsed === number || (parsed === null && index + 1 === number);
  });
  if (!root) return { ok: false, reason: `nao encontrei a questao ${number} visivel` };

  const optionRoot = findOptionRoot(root, letter);
  if (!optionRoot) return { ok: false, reason: `nao encontrei a alternativa ${letter} na questao ${number}` };
  optionRoot.scrollIntoView({ block: 'center', inline: 'center' });
  optionRoot.click();
  optionRoot.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  optionRoot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  optionRoot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { ok: true };
}

function clickOptionByQuestionTestId(number, letter) {
  const root = document.querySelector(`[data-testid="question-${number}"]`);
  if (!root) return { ok: false, reason: `nao encontrei data-testid question-${number}` };

  const optionRoot = findOptionRoot(root, letter);
  if (!optionRoot) return { ok: false, reason: `nao encontrei a alternativa ${letter} dentro de question-${number}` };

  optionRoot.scrollIntoView({ block: 'center', inline: 'center' });
  optionRoot.click();
  optionRoot.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  optionRoot.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  optionRoot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { ok: true };
}

function findOptionRoot(root, letter) {
  const exactLetterElements = [...root.querySelectorAll('*')].filter(visible).filter((element) => textOf(element).trim().toUpperCase() === letter);
  for (const letterElement of exactLetterElements) {
    const optionRoot = climbToOptionContainer(root, letterElement, letter);
    if (optionRoot) return optionRoot;
  }

  const candidates = [...root.querySelectorAll('label, button, [role="radio"], [role="button"], div, li')]
    .filter(visible)
    .filter((element) => {
      const text = textOf(element);
      return new RegExp(`^${letter}\\b`, 'i').test(text) && text.length > 8 && text.length < 1200;
    })
    .sort((a, b) => textOf(a).length - textOf(b).length);
  return candidates[0] ?? null;
}

function climbToOptionContainer(boundary, start, letter) {
  let best = null;
  for (let element = start; element && element !== boundary.parentElement; element = element.parentElement) {
    const text = textOf(element);
    if (!new RegExp(`^${letter}\\b`, 'i').test(text)) continue;
    if (text.length < 8 || text.length > 1200) continue;
    best = element;

    const style = window.getComputedStyle(element);
    const clickable =
      element.tagName === 'LABEL' ||
      element.tagName === 'BUTTON' ||
      element.getAttribute('role') === 'radio' ||
      element.getAttribute('role') === 'button' ||
      style.cursor === 'pointer';
    if (clickable) return element;
  }
  return best;
}

function nearestSiblingText(optionRoot, letter) {
  const parent = optionRoot.parentElement;
  if (!parent) return '';
  return textOf(parent).replace(new RegExp(`^${letter}\\s*\\n?\\s*`, 'i'), '').trim();
}

function cleanInlineText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function textOf(element) {
  return (element?.innerText || element?.textContent || '').replace(/\u00a0/g, ' ').trim();
}

function visible(element) {
  if (!element || !(element instanceof Element)) return false;
  const style = window.getComputedStyle(element);
  if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

async function collectEvaluations() {
  await openUrl(EVALUATIONS_URL);
  await accessFirstEvaluation();
}

async function accessFirstEvaluation() {
  await page.waitForFunction(() => document.body?.innerText?.includes('Minhas Disciplinas'), null, { timeout: 30000 }).catch(() => {});

  const selectors = [
    '[data-testid="btn-acessar-avaliacoes"]',
    '#btn-acessar-avaliacoes',
    '.btn-acessar-avaliacoes',
    'button.btn-acessar-avaliacoes',
    'a.btn-acessar-avaliacoes',
    'button:has-text("Avaliações")',
    '[role="button"]:has-text("Avaliações")',
  ];

  const firstEvaluationButton = await waitForAnyVisible(selectors, 30000);
  if (firstEvaluationButton) {
    await firstEvaluationButton.click();
  } else {
    const clicked = await page.evaluate(() => {
      const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const candidates = [...document.querySelectorAll('button, a, [role="button"], div, span, p')]
        .filter((element) => /^Avaliações$/i.test(clean(element.innerText || element.textContent)));

      for (const candidate of candidates) {
        let card = candidate;
        for (let i = 0; i < 8 && card.parentElement; i += 1) {
          card = card.parentElement;
          const text = clean(card.innerText || card.textContent);
          if (/Minhas Disciplinas/i.test(text)) break;
          if (/Avaliações/i.test(text) && text.length > 20 && text.length < 600) {
            const clickable =
              candidate.closest('button, a, [role="button"]') ||
              [...card.querySelectorAll('button, a, [role="button"]')].find((element) =>
                /^Avaliações$/i.test(clean(element.innerText || element.textContent)),
              ) ||
              candidate;
            clickable.click();
            return true;
          }
        }
      }

      return false;
    });

    if (!clicked) {
      throw new Error('nao encontrei nenhum btn-acessar-avaliacoes na pagina de avaliacoes');
    }
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForURL(/saladeavaliacoes\.com\.br\/avaliacoes\/[^/?]+\/?/, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2500);
  console.log(`Acessei a primeira avaliacao: ${page.url()}`);
  await clickSimuladosIfAvailable();
}

async function clickSimuladosIfAvailable() {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => document.body?.innerText?.includes('Simulados'), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const hasSimulados = await page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const sidebars = [...document.querySelectorAll('.sidebar-box-wrapper, [class*="sidebar-box-wrapper"]')];
    return (
      sidebars.some((sidebar) => /Simulados/i.test(clean(sidebar.innerText || sidebar.textContent))) ||
      /Simulados/i.test(clean(document.body?.innerText || document.body?.textContent))
    );
  }).catch(() => false);

  if (!hasSimulados) {
    console.log('Nao encontrei a opcao Simulados no sidebar.');
    return;
  }

  const selectors = [
    '[data-element="button_avaliacao-Simulado"]',
    '[data-testid="evaluation-type-Simulado-test-id"]',
    '[data-testid="button_avaliacao-Simulado"]',
    '#button_avaliacao-Simulado',
    'button[data-element="button_avaliacao-Simulado"]',
    'button:has-text("Simulados")',
    '[role="button"]:has-text("Simulados")',
  ];

  const button = await waitForAnyVisible(selectors, 15000);
  if (!button) {
    console.log('Encontrei Simulados no sidebar, mas nao encontrei o botao button_avaliacao-Simulado.');
    return;
  }

  await button.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  console.log(`Cliquei em Simulados: ${page.url()}`);
  await accessFirstPendingSimulation();
}

async function accessFirstPendingSimulation() {
  await page.waitForFunction(
    () => /Simulado|Acessar|Continuar|Retomar/i.test(document.body?.innerText || ''),
    null,
    { timeout: 20000 },
  ).catch(() => {});
  await page.waitForTimeout(800);

  const result = await page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isEnabled = (element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    const buttonText = (element) => clean(element.innerText || element.textContent);

    const cardCandidates = [...document.querySelectorAll('section, article, li, div')]
      .filter(isVisible)
      .map((element) => ({ element, text: clean(element.innerText || element.textContent) }))
      .filter(({ text }) => /Simulado/i.test(text) && text.length > 20 && text.length < 1800)
      .filter(({ element }) => element.querySelector('button, a, [role="button"], .css-1ujby1e'))
      .sort((a, b) => {
        const priority = ({ text }) => {
          if (/N(?:a|\u00e3)o realizada/i.test(text)) return 0;
          if (/Em andamento|Iniciad[ao]|Continuar|Retomar/i.test(text)) return 1;
          if (!/Realizada em|Acessar gabarito/i.test(text)) return 2;
          return 9;
        };
        return priority(a) - priority(b) || a.text.length - b.text.length;
      });

    for (const { element: card, text: cardText } of cardCandidates) {
      if (/Realizada em|Acessar gabarito/i.test(cardText) && !/Continuar|Retomar/i.test(cardText)) continue;

      const clickableCandidates = [
        ...card.querySelectorAll('button, a, [role="button"], .css-1ujby1e'),
      ].filter(isVisible).filter(isEnabled);

      const accessButton = clickableCandidates.find((element) => {
        const text = buttonText(element);
        if (/gabarito/i.test(text)) return false;
        return /^(Acessar|Continuar|Retomar)$/i.test(text) || element.classList.contains('css-1ujby1e');
      });

      if (accessButton) {
        accessButton.scrollIntoView({ block: 'center', inline: 'center' });
        accessButton.click();
        return { ok: true, label: buttonText(accessButton) || accessButton.className };
      }
    }

    return { ok: false, reason: 'nao encontrei um simulado disponivel com botao Acessar, Continuar ou Retomar' };
  });

  if (!result.ok) {
    console.log(result.reason);
    return;
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  console.log(`Cliquei no simulado disponivel (${result.label}): ${page.url()}`);
  await handleSimulationAfterAccess();
}

async function handleSimulationAfterAccess() {
  if (await waitForExamQuestionsReady(5000)) {
    console.log('A prova ja estava aberta. Vou executar o comando prompt automaticamente.');
    await savePromptForChat();
    return;
  }

  const hasInstructions = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return /Sou respons[a\u00e1]vel|Estou ciente|Come(?:c|\u00e7)ar Prova/i.test(text);
  }).catch(() => false);

  if (hasInstructions) {
    await acceptInstructionsAndStartExam();
    return;
  }

  console.log('Acessei o simulado, mas ainda nao encontrei a tela de orientacoes nem as questoes.');
}

async function acceptInstructionsAndStartExam() {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(
    () => /Sou respons[a\u00e1]vel|Estou ciente|Come(?:c|\u00e7)ar Prova/i.test(document.body?.innerText || ''),
    null,
    { timeout: 20000 },
  ).catch(() => {});
  await page.waitForTimeout(1000);

  const accepted = await markInstructionCheckboxes();

  if (!accepted.ok) {
    console.log(accepted.reason || 'Nao consegui marcar as duas checkbox de orientacao.');
    return;
  }

  await page.waitForTimeout(800);
  await page.waitForFunction(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const isEnabled = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        !element.disabled &&
        element.getAttribute('aria-disabled') !== 'true'
      );
    };
    return [...document.querySelectorAll('button, [role="button"]')]
      .some((element) => /Come(?:c|\u00e7)ar Prova/i.test(clean(element.innerText || element.textContent)) && isEnabled(element));
  }, null, { timeout: 15000 }).catch(() => {});

  const startSelectors = [
    'button:has-text("Começar Prova")',
    'button:has-text("Comecar Prova")',
    '[role="button"]:has-text("Começar Prova")',
    '[role="button"]:has-text("Comecar Prova")',
    'button:has(.css-18eckzp)',
    '.css-18eckzp',
  ];
  const startButton = await waitForAnyVisible(startSelectors, 15000);
  if (startButton) {
    await startButton.click();
  } else {
    const clicked = await page.evaluate(() => {
      const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const candidates = [...document.querySelectorAll('button, [role="button"], .css-18eckzp')];
      const element = candidates.find((candidate) => /Come(?:c|\u00e7)ar Prova/i.test(clean(candidate.innerText || candidate.textContent)) || candidate.classList.contains('css-18eckzp'));
      const clickable = element?.closest('button, [role="button"]') || element;
      if (!clickable) return false;
      clickable.scrollIntoView({ block: 'center', inline: 'center' });
      clickable.click();
      return true;
    });
    if (!clicked) {
      console.log('Checkboxes marcadas, mas nao encontrei o botao Comecar Prova.');
      return;
    }
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  console.log(`Comecei a prova: ${page.url()}`);
  await runPromptAutomaticallyAfterExamStart();
}

async function runPromptAutomaticallyAfterExamStart() {
  const ready = await waitForExamQuestionsReady(30000);
  if (!ready) {
    console.log('Prova iniciada, mas ainda nao encontrei as questoes para gerar o prompt automaticamente.');
    return;
  }

  console.log('Questoes carregadas. Vou executar o comando prompt automaticamente.');
  await savePromptForChat();
}

async function waitForExamQuestionsReady(totalTimeoutMs) {
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return /Marcar para revis(?:a|\u00e3)o/i.test(text) || /Quest(?:a|\u00e3)o\s*1/i.test(text);
    }).catch(() => false);
    if (ready) return true;

    await page.waitForTimeout(700);
  }
  return false;
}

async function markInstructionCheckboxes() {
  const targets = [
    {
      label: 'responsavel',
      pattern: /Sou respons[aá]vel pela realiza[cç][aã]o desta prova/i,
    },
    {
      label: 'ciente',
      pattern: /Estou ciente de que a prova [eé] individual e sem consulta/i,
    },
  ];

  let checkedCount = await countVisibleInstructionChecks();
  if (checkedCount >= 2) return { ok: true, checkedCount };

  for (const target of targets) {
    const index = await findInstructionCheckboxIndex(target.pattern.source);
    if (index < 0) {
      return { ok: false, reason: `nao encontrei o input checkbox do termo ${target.label}` };
    }

    const checkbox = page.locator('input[data-testid="checkbox"], input[data-lift="lft-input-checkbox"], input[type="checkbox"]').nth(index);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const isChecked = await checkbox.evaluate((element) => element.checked || element.getAttribute('aria-checked') === 'true').catch(() => false);
      if (isChecked) break;

      await checkbox.check({ force: true }).catch(async () => {
        const box = await checkbox.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      await page.waitForTimeout(500);
    }

    const confirmed = await checkbox.evaluate((element) => element.checked || element.getAttribute('aria-checked') === 'true').catch(() => false);
    if (!confirmed) {
      return { ok: false, reason: `cliquei no checkbox ${target.label}, mas o aria-checked nao virou true` };
    }
  }

  checkedCount = await countVisibleInstructionChecks();
  if (checkedCount < 2) {
    return { ok: false, reason: `cliquei nas checkbox, mas detectei apenas ${checkedCount} check(s) css-3r2xms` };
  }

  return { ok: true, checkedCount };
}

async function findInstructionCheckboxIndex(patternSource) {
  return page.evaluate((source) => {
    const pattern = new RegExp(source, 'i');
    const checkboxes = [...document.querySelectorAll('input[data-testid="checkbox"], input[data-lift="lft-input-checkbox"], input[type="checkbox"]')];
    return checkboxes.findIndex((input) => pattern.test(input.id || '') || pattern.test(input.name || ''));
  }, patternSource).catch(() => -1);
}

async function countVisibleInstructionChecks() {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const iconCount = [...document.querySelectorAll('.css-3r2xms')].filter(isVisible).length;
    const inputCount = [...document.querySelectorAll('input[data-testid="checkbox"], input[data-lift="lft-input-checkbox"], input[type="checkbox"]')]
      .filter((input) => input.checked || input.getAttribute('aria-checked') === 'true')
      .length;
    return Math.max(iconCount, inputCount);
  }).catch(() => 0);
}

async function findInstructionCheckboxPoint(patternSource) {
  return page.evaluate((source) => {
    const pattern = new RegExp(source, 'i');
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const textElement = [...document.querySelectorAll('label, p, span, div')]
      .filter(isVisible)
      .filter((element) => pattern.test(clean(element.innerText || element.textContent)))
      .sort((a, b) => clean(a.innerText || a.textContent).length - clean(b.innerText || b.textContent).length)[0];

    if (!textElement) return { ok: false, reason: 'texto do termo nao encontrado' };
    textElement.scrollIntoView({ block: 'center', inline: 'center' });

    const textRect = textElement.getBoundingClientRect();
    const textMidY = textRect.top + textRect.height / 2;
    const nearbyBoxes = [...document.querySelectorAll('*')]
      .filter(isVisible)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => {
        const midY = rect.top + rect.height / 2;
        return (
          rect.width >= 14 &&
          rect.width <= 36 &&
          rect.height >= 14 &&
          rect.height <= 36 &&
          rect.left < textRect.left &&
          Math.abs(midY - textMidY) <= 24
        );
      })
      .sort((a, b) => Math.abs(a.rect.right - textRect.left) - Math.abs(b.rect.right - textRect.left));

    const box = nearbyBoxes[0]?.rect;
    if (box) {
      return {
        ok: true,
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
      };
    }

    return {
      ok: true,
      x: Math.max(4, textRect.left - 28),
      y: textMidY,
    };
  }, patternSource);
}

async function collectEvaluationsIfLoggedIn() {
  if (!page.url().includes('estudante.estacio.br/disciplinas')) return;
  if (!(await isLoggedInEstacio())) return;

  console.log('Usuario logado detectado em disciplinas. Vou abrir avaliacoes e acessar a primeira prova.');
  await collectEvaluations();
}
