import { firefox } from 'playwright';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const USER_DATA_DIR = path.resolve('.browser-profile');
const OUTPUT_FILE = path.resolve('leitura-prova.json');
const PROMPT_FILE = path.resolve('prompt-prova.txt');
const ANSWERS_TEXT_FILE = path.resolve('respostas.txt');
const CHATGPT_PAGE_TEXT_FILE = path.resolve('chatgpt-pagina.txt');
const HOME_URL = 'https://estudante.estacio.br/inicio';
const DEFAULT_SITE_URL = 'https://estudante.estacio.br/disciplinas';
const EVALUATIONS_URL = 'https://estudante.estacio.br/avaliacoes';
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHATGPT_PROVAS_URL = 'https://chatgpt.com/c/69ff2b24-07c4-83e9-b883-9f849ee8f433';
const VALID_LETTERS = new Set(['A', 'B', 'C', 'D', 'E']);
const TARGET_EXERCISE_THEME = Number(process.env.TEMA_EXERCICIO || 0);
const STOP_AFTER_OPEN_EXERCISE = process.env.STOP_AFTER_OPEN_EXERCISE === '1';
const ANSWER_PROMPT_TEMPLATE = `
Voce e um especialista em { titulo prova } e vai resolver uma avaliacao objetiva.

Objetivo:
Responder exatamente as questoes abaixo, escolhendo uma unica alternativa entre A, B, C, D ou E para cada questao.

Regras obrigatorias:
1. Comece sua resposta obrigatoriamente com uma linha neste formato exato:
RESPOSTAS: A B C D E A B C D E
2. A linha RESPOSTAS deve ter exatamente 10 letras, separadas por espaco, na ordem da questao 1 ate a questao 10.
3. Nao use texto antes da linha RESPOSTAS.
4. Use somente as letras A, B, C, D ou E na linha RESPOSTAS.
5. Depois da linha RESPOSTAS, explique rapidamente cada escolha em uma frase curta.
6. Se uma pergunta estiver ambigua, escolha a alternativa mais correta de acordo com o tema "{ titulo prova }" e com o enunciado.
7. Nao invente alternativas fora das opcoes enviadas.

Prova:
{ questoes }
`.trim();

const rl = readline.createInterface({ input, output });

let lastRead = null;
let currentEvaluationIndex = 0;
let currentExerciseTitle = '';
let currentExerciseListUrl = '';
const processedExerciseThemeKeys = new Set();

const startMode = process.env.START_MODE
  ? normalizeText(process.env.START_MODE)
  : await askStartMode();

await cleanupFirefoxSessionState();
if (process.env.DEBUG_BOT === '1') console.log('Abrindo Firefox...');
const context = await firefox.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  viewport: { width: 1366, height: 768 },
  timeout: 45000,
});

const page = context.pages()[0] ?? await context.newPage();
page.setDefaultTimeout(5000);

const debugLog = process.env.DEBUG_BOT === '1' ? console.log.bind(console) : () => {};
const statusEvaluation = (status) => {
  console.log(`Avalia\u00e7\u00e3o ${currentEvaluationIndex + 1}: ${status}.`);
};
const chatMinimizer = setInterval(() => {
  void minimizePersonalAssistantChat().catch(() => {});
}, 2000);
chatMinimizer.unref?.();

try {
  if (startMode === 'exercicio') {
    await openExercisesFromHome();
  } else {
    await openUrl(DEFAULT_SITE_URL);
    await collectEvaluationsIfLoggedIn();
  }
} catch (error) {
  console.log(`Nao consegui executar o inicio automatico: ${error.message}`);
}
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
      else if (command === 'exercicio' || command === 'exercicios') await openExercisesFromHome();
      else if (command === 'prova') await openUrl(buildExamUrl(args[0] ?? ''));
      else if (command === 'ler') await readVisibleExam();
      else if (command === 'prompt') await savePromptForChat();
      else if (command === 'aplicar' || command === 'respostas') await applyAnswerList(args);
      else if (command === 'salvar') await saveLastRead();
      else if (command === 'marcar') await markOption(args);
      else if (command === 'scroll') await scrollPage(args[0]);
      else if (command === 'ir') await goToQuestion(args[0]);
      else debugLog('Comando desconhecido. Digite "ajuda" para ver as opcoes.');
    } catch (error) {
      debugLog(`Nao consegui executar isso: ${error.message}`);
    }
  }
} finally {
  clearInterval(chatMinimizer);
  rl.close();
  await context.close();
  await cleanupFirefoxSessionState();
}

async function askPrompt() {
  try {
    return await rl.question(`\n${startMode}> `);
  } catch (error) {
    if (error?.code === 'ERR_USE_AFTER_CLOSE') return 'sair';
    throw error;
  }
}

async function askStartMode() {
  while (true) {
    const answer = (await rl.question('Escolha o modo (avaliacao/exercicio): ')).trim().toLowerCase();
    const normalized = normalizeText(answer);

    if (['1', 'a', 'avaliacao', 'avaliacoes'].includes(normalized)) return 'avaliacao';
    if (['2', 'e', 'exercicio', 'exercicios'].includes(normalized)) return 'exercicio';

    console.log('Digite "avaliacao" ou "exercicio".');
  }
}

function printBanner() {
  debugLog('Assistente de prova aberto.');
  debugLog('Use apenas em provas suas ou ambientes em que voce tenha autorizacao.');
  printHelp();
}

function printHelp() {
  debugLog(`
Comandos:
  site              Abre https://estudante.estacio.br/disciplinas
  avaliacoes        Abre avaliacoes e acessa a primeira prova
  exercicios        Abre Disciplinas e acessa o card de exercicios
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

async function cleanupFirefoxSessionState() {
  const volatileProfileItems = [
    'parent.lock',
    '.startup-incomplete',
    'sessionstore.jsonlz4',
    'sessionstore-backups',
    'sessionCheckpoints.json',
    'startupCache',
    'xulstore.json',
  ];

  await Promise.all(volatileProfileItems.map((item) => (
    rm(path.join(USER_DATA_DIR, item), { recursive: true, force: true }).catch(() => {})
  )));
}

function buildExamUrl(keyOrUrl) {
  if (/^https?:\/\//i.test(keyOrUrl)) return keyOrUrl;
  const key = keyOrUrl.replace(/^\/+|\/+$/g, '');
  if (!key) throw new Error('informe a chave da prova. Exemplo: prova 69f3...');
  return `https://estacio.saladeavaliacoes.com.br/prova/${key}/`;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function openUrl(rawUrl) {
  if (!rawUrl) throw new Error('informe uma URL');
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await minimizePersonalAssistantChat();
  debugLog(`Aberto: ${url}`);
}

async function minimizePersonalAssistantChat() {
  const minimized = await page.evaluate(() => {
    const section = document.querySelector('[data-testid="section-chat-assistente-pessoal"]');
    if (!section) return false;

    const button =
      section.querySelector('[data-testid="minimize-button"]') ||
      section.querySelector('[data-element="button_minimizar-chat-interno"]') ||
      section.querySelector('button[aria-label="Minimizar chat"]') ||
      document.querySelector('button[data-testid="minimize-button"]') ||
      document.querySelector('button[data-element="button_minimizar-chat-interno"]');

    const clickable = button?.closest('button, [role="button"]') || button;
    if (!clickable) return false;

    clickable.scrollIntoView({ block: 'center', inline: 'center' });
    clickable.click();
    clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }).catch(() => false);

  if (minimized) {
    await page.waitForTimeout(300);
    return true;
  }

  return false;
}

async function openExercisesFromHome() {
  debugLog('Exercicio: abrindo inicio.');
  await openUrl(HOME_URL);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1000);

  debugLog('Exercicio: abrindo sidebar.');
  await openHomeSidebar();
  await page.waitForTimeout(500);

  debugLog('Exercicio: abrindo Meu curso.');
  const openedCourseMenu = await clickMenuMeuCurso();
  if (!openedCourseMenu) throw new Error('nao encontrei o menu Meu curso na sidebar');
  await page.waitForTimeout(500);

  debugLog('Exercicio: clicando em Disciplinas.');
  const clicked = await clickMenuDisciplinas();
  if (!clicked) throw new Error('nao encontrei "Disciplinas" na sidebar do inicio');

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1000);
  debugLog('Exercicio: escondendo menu.');
  await hideExercisesSidebar();
  debugLog('Exercicio: abrindo card Lista de Exercicios.');
  await openExercisesCardFromDisciplines();
}

async function openExercisesCardFromDisciplines() {
  debugLog('Exercicio: procurando card-progresso-semestre-exercicio.');
  const clicked = await clickVisibleBySelectors([
    '[data-testid="lista-card-progresso-semestre"] [data-testid="card-progresso-semestre-exercicio"]',
    '[data-testid="lista-card-progresso-semestre"] [data-element="card-progresso-semestre-exercicio"]',
    '[data-testid="lista-card-progresso-semestre"] [data-element="button_exercicios"]',
    '[data-testid="progresso-semestre-container"] [data-testid="card-progresso-semestre-exercicio"]',
    '[data-testid="progresso-semestre-container"] [data-element="card-progresso-semestre-exercicio"]',
    '[data-testid="card-progresso-semestre-exercicio"]',
    '[data-element="card-progresso-semestre-exercicio"]',
    '[data-element="button_exercicios"]',
  ], 4000);

  if (!clicked) {
    const fallback = await page.evaluate(() => {
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const roots = [...document.querySelectorAll('[data-testid="lista-card-progresso-semestre"], [data-testid="progresso-semestre-container"], [data-lift="lft-cardshape"], .css-6lcv8m, .css-12kbgrh')];
      const candidates = (roots.length > 0 ? roots : [document.body])
        .flatMap((root) => [...root.querySelectorAll('[data-element], [data-testid], button, [role="button"], a, div')]);
      const card = candidates.find((element) => {
        const dataElement = element.getAttribute('data-element') || '';
        const dataTestId = element.getAttribute('data-testid') || '';
        const text = (element.innerText || element.textContent || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        return isVisible(element) && (
          dataElement === 'button_exercicios' ||
          dataTestId === 'button_exercicios' ||
          dataTestId === 'card-progresso-semestre-exercicio' ||
          dataElement === 'card-progresso-semestre-exercicio' ||
          text.includes('lista de exercicios')
        );
      });

      const clickable = card?.closest('button, [role="button"], a') || card;
      if (!clickable) return false;
      clickable.scrollIntoView({ block: 'center', inline: 'center' });
      clickable.click();
      return true;
    }).catch(() => false);

    if (!fallback) throw new Error('nao encontrei o card card-progresso-semestre-exercicio');
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1000);
  debugLog('Exercicio: clicando na disciplina dentro de Lista de Exercicios.');
  await clickFirstExerciseDisciplineButton();
  currentExerciseListUrl = page.url();
  debugLog('Exercicio: clicando menu Lista de Exercicios.');
  await clickExerciseListMenuItem();
  await processPendingExerciseThemes();
}

async function clickFirstExerciseDisciplineButton() {
  const clicked = await clickVisibleBySelectors([
    '[data-lift="lft-cardshape"] button[data-testid="botao-acessar-disciplina"]',
    '[data-lift="lft-cardshape"] button[data-element^="button_acessar-disciplina"]',
    '.css-6lcv8m button[data-testid="botao-acessar-disciplina"]',
    '.css-6lcv8m button[data-element^="button_acessar-disciplina"]',
    'button[data-testid="botao-acessar-disciplina"]',
    'button[data-element^="button_acessar-disciplina"]',
  ], 15000);

  if (!clicked) {
    const fallback = await page.evaluate(() => {
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const roots = [...document.querySelectorAll('[data-lift="lft-cardshape"], .css-6lcv8m, .css-12kbgrh')];
      const candidates = (roots.length > 0 ? roots : [document.body])
        .flatMap((root) => [...root.querySelectorAll('button, [role="button"], a')]);
      const button = candidates.find((element) => {
        const dataElement = element.getAttribute('data-element') || '';
        const dataTestId = element.getAttribute('data-testid') || '';
        return isVisible(element) && (
          dataTestId === 'botao-acessar-disciplina' ||
          dataElement.startsWith('button_acessar-disciplina')
        );
      });

      if (!button) return false;
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return true;
    }).catch(() => false);

    if (!fallback) throw new Error('nao encontrei o botao botao-acessar-disciplina');
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await forceDisciplineExercisesUrl();
  debugLog(`Exercicio: URL da disciplina: ${page.url()}`);
  await page.waitForTimeout(1200);
}

async function forceDisciplineExercisesUrl() {
  await page.waitForFunction(() => /estudante\.estacio\.br\/disciplinas\/[^/]+/i.test(location.href), null, { timeout: 12000 }).catch(() => {});

  const currentUrl = page.url();
  const match = currentUrl.match(/^(https:\/\/estudante\.estacio\.br\/disciplinas\/[^/?#]+)(?:\/[^/?#]+)?([?#].*)?$/i);
  if (!match) return;

  const targetUrl = `${match[1]}/exercicios${match[2] || ''}`;
  if (currentUrl !== targetUrl) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  }

  await page.waitForURL(/estudante\.estacio\.br\/disciplinas\/[^/]+\/exercicios/i, { timeout: 12000 }).catch(() => {});
}

async function clickExerciseListMenuItem() {
  const clicked = await page.evaluate(() => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const root = document.querySelector('menu.css-g1721d') || document.querySelector('menu') || document.body;
    const item = [...root.querySelectorAll('li, button, [role="button"], a, div, span')]
      .filter(isVisible)
      .find((element) => normalize(element.innerText || element.textContent) === 'lista de exercicios');
    const clickable = item?.closest('button, [role="button"], a, li') || item;
    if (!clickable) return false;
    clickable.scrollIntoView({ block: 'center', inline: 'center' });
    clickable.click();
    return true;
  }).catch(() => false);

  if (!clicked) {
    debugLog('Nao encontrei o menu Lista de Exercicios; vou seguir procurando tema pendente.');
    return false;
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(800);
  return true;
}

async function processPendingExerciseThemes() {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    await ensureExerciseListPage();
    const skippedKeys = [...processedExerciseThemeKeys];
    const pendingCount = await countPendingExerciseThemes(skippedKeys);
    debugLog(`Exercicio: temas pendentes nesta disciplina: ${pendingCount}.`);

    if (pendingCount <= 0) {
      debugLog('Exercicio: nao ha mais temas pendentes nesta disciplina.');
      return;
    }

    debugLog(`Exercicio: abrindo tema pendente ${attempt}.`);
    const openedTheme = await clickFirstPendingExerciseTheme(skippedKeys);
    if (openedTheme?.key) processedExerciseThemeKeys.add(openedTheme.key);
    currentExerciseTitle = await readExercisePageTitle();
    await runExercisePromptAutomaticallyAfterStart({ returnToListUrl: currentExerciseListUrl });
  }

  debugLog('Exercicio: parei apos 20 tentativas para evitar loop infinito.');
}

async function ensureExerciseListPage() {
  if (!currentExerciseListUrl) currentExerciseListUrl = page.url();

  if (!/estudante\.estacio\.br\/disciplinas\/[^/]+\/exercicios/i.test(page.url())) {
    await page.goto(currentExerciseListUrl, { waitUntil: 'domcontentloaded' });
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    return /Lista de Exerc[ií]cios da disciplina|Tema\s*\d+|Pendente|Conclu[ií]do/i.test(text);
  }, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function countPendingExerciseThemes(skippedKeys = []) {
  return page.evaluate((skipList) => {
    const skipped = new Set(skipList);
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const root =
      document.querySelector('[data-testid="container-exercicios"]') ||
      document.querySelector('[data-section="section_sava-exercicios-da-disciplina"]') ||
      document.body;
    const grid = root.querySelector('[data-testid="grid-conteudos"]') || root;
    return [...grid.querySelectorAll('[data-testid="card-tag"], [data-lift="lft-tag"], [aria-label="Pendente"]')]
      .filter(isVisible)
      .filter((tag) => {
        const text = normalize(tag.innerText || tag.textContent || tag.getAttribute('aria-label'));
        if (text !== 'pendente') return false;
        const card = tag.closest('section, article, [data-lift="lft-cardshape"], [class*="card"]') || tag.closest('footer') || tag;
        const button = card.querySelector('button[data-testid="card-sucesso-botao"], button[data-element^="button_acessar-exercicio"], button[aria-label*="Acessar" i]');
        const key =
          button?.getAttribute('data-info') ||
          button?.getAttribute('data-element') ||
          normalize(card.innerText || card.textContent).slice(0, 180);
        return !skipped.has(key);
      })
      .length;
  }, skippedKeys).catch(() => 0);
}

async function clickFirstPendingExerciseTheme(skippedKeys = []) {
  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    return /Tema\s*\d+|Pendente|Conclu[ií]do/i.test(text);
  }, null, { timeout: 20000 }).catch(() => {});

  const result = await page.evaluate(({ targetTheme, skipList }) => {
    const skipped = new Set(skipList);
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const isEnabled = (element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true';

    const root =
      document.querySelector('[data-testid="container-exercicios"]') ||
      document.querySelector('[data-section="section_sava-exercicios-da-disciplina"]') ||
      document.querySelector('section.css-klisov') ||
      document.body;
    const listRoot =
      root.querySelector('[data-testid="grid-conteudos"]') ||
      root.querySelector('.css-533vxd') ||
      root;

    const pendingFooters = [...listRoot.querySelectorAll('footer')]
      .filter(isVisible)
      .filter((footer) => {
        const tag = footer.querySelector('[data-testid="card-tag"], [data-lift="lft-tag"], [aria-label="Pendente"]');
        const tagText = normalize(tag?.innerText || tag?.textContent || tag?.getAttribute?.('aria-label'));
        return tagText === 'pendente' || normalize(footer.innerText || footer.textContent).includes('pendente');
      });

    const pendingCards = pendingFooters
      .map((footer) => footer.closest('section, article, [data-lift="lft-cardshape"], [class*="card"]') || footer.parentElement || footer)
      .filter(Boolean);

    const rawSections = [
      ...pendingCards,
      ...listRoot.querySelectorAll('section.css-pgnbd, .css-pgnbd.e1bzjf1t1, .css-pgnbd, section, article'),
    ];
    const byElement = new Map();
    for (const section of rawSections) byElement.set(section, section);

    for (const badge of [...listRoot.querySelectorAll('span, div, small, p')].filter(isVisible)) {
      if (normalize(badge.innerText || badge.textContent) !== 'pendente') continue;
      const card = badge.closest('section.css-pgnbd, .css-pgnbd.e1bzjf1t1, .css-pgnbd, section, article, [data-lift="lft-cardshape"], [class*="card"]');
      if (card) byElement.set(card, card);
    }

    const sections = [...byElement.values()]
      .filter(isVisible)
      .map((section) => ({
        section,
        text: normalize(section.innerText || section.textContent),
      }))
      .filter(({ text }) => text.includes('tema') && text.includes('pendente') && text.length > 10 && text.length < 2500)
      .sort((a, b) => a.text.length - b.text.length);

    const exactTheme = (text) => targetTheme > 0 && new RegExp(`\\btema\\s*${targetTheme}\\b`).test(text);
    const preferredSections = targetTheme > 0
      ? [
        ...sections.filter(({ text }) => exactTheme(text)),
        ...sections.filter(({ text }) => !exactTheme(text)),
      ]
      : sections;

    for (const { section, text: sectionText } of preferredSections) {
      const footerButton = [...section.querySelectorAll('footer button[data-testid="card-sucesso-botao"], footer button[data-element^="button_acessar-exercicio"]')]
        .filter(isVisible)
        .filter(isEnabled)
        .find((element) => {
          const footer = element.closest('footer');
          return normalize(footer?.innerText || footer?.textContent).includes('pendente');
        });
      const button = footerButton || [...section.querySelectorAll('button[data-testid="card-sucesso-botao"], button[data-element^="button_acessar-exercicio"], button')]
        .filter(isVisible)
        .filter(isEnabled)
        .find((element) => (
          element.getAttribute('data-testid') === 'card-sucesso-botao' ||
          (element.getAttribute('data-element') || '').startsWith('button_acessar-exercicio') ||
          /acessar/i.test(element.getAttribute('aria-label') || '')
        ));
      if (!button) continue;

      const key =
        button.getAttribute('data-info') ||
        button.getAttribute('data-element') ||
        sectionText.slice(0, 180);
      if (skipped.has(key)) continue;

      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return { ok: true, url: location.href, chosen: sectionText.slice(0, 220), key };
    }

    return {
      ok: false,
      url: location.href,
      total: sections.length,
      samples: sections.slice(0, 6).map(({ text }) => text.slice(0, 240)),
      body: normalize(document.body?.innerText || document.body?.textContent || '').slice(0, 900),
    };
  }, { targetTheme: TARGET_EXERCISE_THEME, skipList: skippedKeys }).catch(() => false);

  if (!result?.ok) {
    const samples = Array.isArray(result?.samples) && result.samples.length
      ? ` Amostras: ${result.samples.join(' | ')}`
      : '';
    const body = result?.body ? ` Texto da pagina: ${result.body}` : '';
    throw new Error(`nao encontrei tema pendente com botao card-sucesso-botao. URL: ${result?.url || page.url()}.${samples}${body}`);
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForURL(/estacio\.saladeavaliacoes\.com\.br\/exercicio\//i, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  if (STOP_AFTER_OPEN_EXERCISE) {
    console.log(`URL atual: ${page.url()}`);
    await shutdownAndExit();
  }
  return result;
}

async function hideExercisesSidebar() {
  const hideButton = await waitForAnyVisible([
    'button.css-x43dmm',
    '.css-x43dmm',
    'button:has-text("Esconder")',
    '[role="button"]:has-text("Esconder")',
  ], 8000);

  if (hideButton) {
    const clicked = await hideButton.click({ force: true, timeout: 1500 }).then(() => true).catch(() => false);
    if (!clicked) {
      await clickBySelectorsDom([
        'button.css-x43dmm',
        '.css-x43dmm',
        'button[alt="Esconder Menu"]',
      ]);
    }
    await page.waitForTimeout(500);
  }
}

async function readExercisePageTitle() {
  return page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const titleRoot = document.querySelector('[data-testid="titulo-pagina"]');
    const title = clean(titleRoot?.querySelector('h2')?.innerText || titleRoot?.textContent);
    if (title) return title.replace(/^Disciplina\s*/i, '').trim();

    return clean(document.querySelector('.css-18iwutk')?.textContent || '');
  }).catch(() => '');
}

async function clickExerciseProgressCard() {
  {
    const clicked = await clickVisibleBySelectors([
      '[data-testid="progresso-semestre-container"] [data-testid="card-progresso-semestre-exercicio"]',
      '[data-testid="progresso-semestre-container"] [data-element="card-progresso-semestre-exercicio"]',
      '[data-testid="card-progresso-semestre-exercicio"]',
      '[data-element="card-progresso-semestre-exercicio"]',
      '#card-progresso-semestre-exercicio',
    ], 12000);

    if (clicked) return true;

    const fallback = await page.evaluate(() => {
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const root = document.querySelector('[data-testid="progresso-semestre-container"]') || document.body;
      const candidates = [...root.querySelectorAll('[data-testid], [data-element], button, [role="button"], a, div')];
      const card = candidates.find((element) => {
        const dataElement = element.getAttribute('data-element') || '';
        const dataTestId = element.getAttribute('data-testid') || '';
        const text = normalize(element.innerText || element.textContent);
        return isVisible(element) && (
          dataTestId === 'card-progresso-semestre-exercicio' ||
          dataElement === 'card-progresso-semestre-exercicio' ||
          text.includes('exercicio')
        );
      });

      const clickable = card?.closest('button, [role="button"], a') || card;
      if (!clickable) return false;
      clickable.scrollIntoView({ block: 'center', inline: 'center' });
      clickable.click();
      return true;
    }).catch(() => false);

    return fallback;
  }

  const clicked = await clickVisibleBySelectors([
    '.sc-hIPCAM.kBvaIc.content button[data-testid="button-redirect"]',
    '.sc-hIPCAM.kBvaIc.content button[data-element^="button_fazer-exercicios"]',
    '.sc-hIPCAM.kBvaIc.content button:has-text("Fazer Exercícios")',
    '.sc-hIPCAM.kBvaIc.content button:has-text("Fazer Exercicios")',
    '.content button[data-testid="button-redirect"]',
    '.content button[data-element^="button_fazer-exercicios"]',
    '.content button:has-text("Fazer Exercícios")',
    '.content button:has-text("Fazer Exercicios")',
    'button[data-testid="button-redirect"]',
    'button[data-element^="button_fazer-exercicios"]',
    'button:has-text("Fazer Exercícios")',
    'button:has-text("Fazer Exercicios")',
  ], 12000);

  if (clicked) return true;

  return page.evaluate(() => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const roots = [...document.querySelectorAll('.sc-hIPCAM.kBvaIc.content, .content')];
    const candidates = (roots.length > 0 ? roots : [document.body])
      .flatMap((root) => [...root.querySelectorAll('button, [role="button"], a')]);
    const button = candidates.find((element) => {
      const dataElement = element.getAttribute('data-element') || '';
      const dataTestId = element.getAttribute('data-testid') || '';
      const text = normalize(element.innerText || element.textContent);
      return isVisible(element) && (
        dataTestId === 'button-redirect' ||
        dataElement.startsWith('button_fazer-exercicios') ||
        text.includes('fazer exercicios')
      );
    });

    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return true;
  }).catch(() => false);
}

async function openHomeSidebar() {
  const menuSelectors = [
    'button:has(svg.menu)',
    'svg.menu',
    '.menu',
    'button.menu',
    '[aria-label*="menu" i]',
    '[aria-label*="Menu" i]',
  ];

  const menu = await waitForAnyVisible(menuSelectors, 8000);
  if (menu) {
    const clicked = await menu.click({ force: true, timeout: 1500 }).then(() => true).catch(async () => {
      const parentButton = menu.locator('xpath=ancestor-or-self::button[1]').first();
      if (await parentButton.count().catch(() => 0)) {
        return parentButton.click({ force: true, timeout: 1500 }).then(() => true).catch(() => false);
      }
      return false;
    });
    if (clicked) return true;
  }

  return page.evaluate(() => {
    const svg = document.querySelector('svg.menu, .menu');
    const clickable =
      svg?.closest('button, [role="button"], a') ||
      document.querySelector('button[alt="Abrir Menu"], button[aria-label*="menu" i], [role="button"][aria-label*="menu" i]');
    if (!clickable) return false;
    clickable.scrollIntoView({ block: 'center', inline: 'center' });
    clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }).catch(() => false);
}

async function clickMenuMeuCurso() {
  const clicked = await clickVisibleBySelectors([
    '[data-element="button_menu-meu-curso"]',
    '[data-testid="button_menu-meu-curso"]',
    '#button_menu-meu-curso',
    '.button_menu-meu-curso',
    'button[data-element="button_menu-meu-curso"]',
    '[role="button"][data-element="button_menu-meu-curso"]',
  ], 8000);

  if (clicked) return true;
  return clickSidebarItemByText('meu curso');
}

async function clickMenuDisciplinas() {
  const clicked = await clickVisibleBySelectors([
    '[data-element="button_menu-disciplinas"]',
    '[data-testid="button_menu-disciplinas"]',
    '#button_menu-disciplinas',
    '.button_menu-disciplinas',
    'button.button_menu-disciplinas',
    'button[data-element="button_menu-disciplinas"]',
    '[role="button"][data-element="button_menu-disciplinas"]',
    'a:has-text("Disciplinas")',
    'button:has-text("Disciplinas")',
    '[role="button"]:has-text("Disciplinas")',
  ], 8000);

  if (clicked) return true;
  return clickSidebarItemByText('disciplinas');
}

async function clickVisibleBySelectors(selectors, timeoutMs) {
  await minimizePersonalAssistantChat();
  const locator = await waitForAnyVisible(selectors, timeoutMs);
  if (!locator) return false;
  await minimizePersonalAssistantChat();
  const clicked = await locator.click({ force: true, timeout: 1500 }).then(() => true).catch(() => false);
  if (clicked) return true;
  return clickBySelectorsDom(selectors);
}

async function clickBySelectorsDom(selectors) {
  return page.evaluate((selectorList) => {
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    for (const selector of selectorList) {
      if (selector.includes(':has-text') || selector.includes(':has(')) continue;
      let element = null;
      try {
        element = document.querySelector(selector);
      } catch {
        continue;
      }

      const clickable = element?.closest?.('button, [role="button"], a, li, [tabindex]') || element;
      if (!clickable || !isVisible(clickable)) continue;
      clickable.scrollIntoView({ block: 'center', inline: 'center' });
      clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }

    return false;
  }, selectors).catch(() => false);
}

async function clickSidebarItemByText(targetText) {
  const directSelectors = [
    '[data-element="button_menu-disciplinas"]',
    '[data-testid="button_menu-disciplinas"]',
    '#button_menu-disciplinas',
    '.button_menu-disciplinas',
    'button.button_menu-disciplinas',
    'button[data-element="button_menu-disciplinas"]',
  ];

  const direct = await waitForAnyVisible(directSelectors, 5000);
  if (direct) {
    await minimizePersonalAssistantChat();
    const clicked = await direct.click({ timeout: 1500 }).then(() => true).catch(() => false);
    if (clicked) return true;
    return clickBySelectorsDom(directSelectors);
  }

  return page.evaluate((wantedText) => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const roots = [...document.querySelectorAll('aside, nav, [class*="sidebar"], [class*="menu"], [data-testid*="sidebar"], body')];
    const candidates = roots.flatMap((root) => [...root.querySelectorAll('a, button, [role="button"], div, span, p')]);
    const element = candidates
      .filter(isVisible)
      .find((candidate) => normalize(candidate.innerText || candidate.textContent).includes(wantedText));

    const clickable = element?.closest('a, button, [role="button"]') || element;
    if (!clickable) return false;

    clickable.scrollIntoView({ block: 'center', inline: 'center' });
    clickable.click();
    return true;
  }, normalizeText(targetText));
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
      debugLog('Tela de confirmacao de e-mail detectada: preenchi user_estacio.');
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
      debugLog('Cliquei no botao primario da confirmacao de e-mail.');
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
    debugLog('Arquivo user.env nao encontrado em Prova nem em GitHub; nao preenchi user_estacio.');
    return '';
  }

  const envText = await readFile(userEnvFile, 'utf8');
  const values = parseEnvText(envText);
  const userEstacio = values.user_estacio || values.USER_ESTACIO || values.email_estacio || values.EMAIL_ESTACIO;
  if (!userEstacio) {
    debugLog(`user.env encontrado em ${userEnvFile}, mas sem user_estacio.`);
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
  debugLog('Campo de senha detectado: preenchi password_estacio automaticamente.');

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
      debugLog('Cliquei no botao primario da senha.');
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
    await minimizePersonalAssistantChat().catch(() => {});
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
    debugLog('Usuario logado detectado: cliquei no menu.');
    await page.waitForTimeout(500);
  } catch {
    // Se o clique falhar, apenas segue com a pagina aberta.
  }
}

async function readPasswordEstacio() {
  const userEnvFile = USER_ENV_FILES.find((filePath) => existsSync(filePath));
  if (!userEnvFile) {
    debugLog('Arquivo user.env nao encontrado em Prova nem em GitHub; nao preenchi password_estacio.');
    return '';
  }

  const envText = await readFile(userEnvFile, 'utf8');
  const values = parseEnvText(envText);
  const passwordEstacio = values.password_estacio || values.PASSWORD_ESTACIO;
  if (!passwordEstacio) {
    debugLog(`user.env encontrado em ${userEnvFile}, mas sem password_estacio.`);
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
    debugLog('Nao encontrei questoes visiveis. Role a pagina ou confira se a prova esta aberta.');
    return;
  }

  for (const question of lastRead.questions) {
    debugLog(`\nQuestao ${question.number ?? '?'}: ${question.statement}`);
    for (const option of question.options) debugLog(`  ${option.letter}) ${option.text}`);
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

  debugLog(`Provas pendentes detectadas: ${data.count}`);
  for (const [index, title] of data.titles.entries()) {
    debugLog(`${index + 1}. ${title}`);
  }
  debugLog(`Print salvo em ${EVALUATIONS_SCREENSHOT}`);
  debugLog(`Resultado salvo em ${EVALUATIONS_FILE}`);
}

async function oldCollectEvaluationsIfLoggedIn() {
  if (!page.url().includes('estudante.estacio.br/disciplinas')) return;

  debugLog('Pagina de disciplinas aberta. Vou abrir avaliacoes e listar provas pendentes.');
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
  debugLog(`Leitura salva em ${OUTPUT_FILE}`);
}

async function savePromptForChat(options = {}) {
  const shouldFinalize = options.finalize ?? startMode === 'avaliacao';
  const exerciseReturnUrl = options.exerciseReturnUrl || '';
  lastRead = await collectExam();
  printReadSummary(lastRead);

  const prompt = buildAnswerPrompt(lastRead);

  await writeFile(PROMPT_FILE, prompt, 'utf8');
  debugLog(`Prompt salvo/substituido em ${PROMPT_FILE}`);
  await copyTextToClipboard(prompt);
  debugLog('Prompt copiado para a area de transferencia.');

  const chatText = await openChatGptInChrome(prompt);
  if (chatText) {
    await writeFile(CHATGPT_PAGE_TEXT_FILE, chatText, 'utf8');
    const parsed = extractAnswersFromChatText(chatText);
    if (parsed.length > 0) {
      await writeFile(ANSWERS_TEXT_FILE, `${formatAnswers(parsed)}\n`, 'utf8');
      debugLog(`Respostas detectadas e salvas em ${ANSWERS_TEXT_FILE}`);
      await applyParsedAnswers(parsed, { finalize: shouldFinalize, exerciseReturnUrl });
    } else {
      debugLog(`Texto salvo em ${CHATGPT_PAGE_TEXT_FILE}, mas nao encontrei sequencia de respostas.`);
    }
  }

  debugLog('Revise a tela antes de finalizar a prova manualmente.');
}

async function openChatGptInChrome(prompt) {
  if (!existsSync(CHROME_EXE)) {
    debugLog(`Nao encontrei Chrome em ${CHROME_EXE}. O prompt ja esta copiado.`);
    return '';
  }

  const chromeState = process.platform === 'win32'
    ? (await runPowerShell(`
        $chrome = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
        if (-not $chrome) {
          'none'
        } elseif ($chrome | Where-Object { $_.MainWindowTitle -match 'ChatGPT|Provas' }) {
          'chatgpt'
        } else {
          'chrome'
        }
      `).catch(() => '')).trim()
    : '';

  const hasChrome = chromeState === 'chrome' || chromeState === 'chatgpt';
  const hasChatGptChrome = chromeState === 'chatgpt';

  if (!hasChrome) {
    const child = spawn(CHROME_EXE, [CHATGPT_PROVAS_URL], { detached: true, stdio: 'ignore' });
    child.unref();
    debugLog('Chrome aberto direto no chat Provas.');
  } else if (!hasChatGptChrome) {
    const child = spawn(CHROME_EXE, [CHATGPT_PROVAS_URL], { detached: true, stdio: 'ignore' });
    child.unref();
    debugLog('Chrome ja estava aberto; abri a conversa Provas no Chrome.');
  } else {
    debugLog('Conversa do ChatGPT detectada no Chrome. Vou usar o chat Provas.');
  }

  const hasChromeAfterOpen = process.platform === 'win32'
    ? (await runPowerShell("if (Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }) { 'yes' }").catch(() => '')).trim() === 'yes'
    : false;

  if (!hasChromeAfterOpen) {
    debugLog('Nao consegui confirmar uma janela do Chrome. O prompt ja esta copiado.');
    return '';
  }

  debugLog('Vou focar o Chrome, abrir a conversa Provas, colar, enviar e copiar a resposta.');
  return pasteSendAndCopyChat(prompt);
}

async function pasteSendAndCopyChat(prompt) {
  if (process.platform !== 'win32') {
    debugLog('Cole manualmente com Ctrl+V.');
    return '';
  }

  const promptFileForPowerShell = PROMPT_FILE.replace(/'/g, "''");
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
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
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
    if ([WindowFocus]::IsIconic($chrome.MainWindowHandle)) {
      [WindowFocus]::ShowWindowAsync($chrome.MainWindowHandle, 9) | Out-Null
      Start-Sleep -Milliseconds 300
    }
    [WindowFocus]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 500
    $activated = $shell.AppActivate([int]$chrome.Id)
    if (-not $activated) { exit 2 }
    Start-Sleep -Milliseconds 300
    $foreground = [WindowFocus]::GetForegroundWindow()
    $foregroundPid = 0
    [WindowFocus]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) | Out-Null
    if ($foregroundPid -ne $chrome.Id) {
      [WindowFocus]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
      Start-Sleep -Milliseconds 500
    }
    $shell.SendKeys('^l')
    Start-Sleep -Milliseconds 200
    $shell.SendKeys('${CHATGPT_PROVAS_URL}')
    Start-Sleep -Milliseconds 300
    $shell.SendKeys('{ENTER}')
    Start-Sleep -Milliseconds 4500
    $promptText = Get-Content -LiteralPath '${promptFileForPowerShell}' -Raw -Encoding UTF8
    Set-Clipboard -Value $promptText
    Start-Sleep -Milliseconds 300
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $x = [int]($bounds.Width * 0.58)
    $y = [int]($bounds.Height * 0.88)
    [MouseClicker]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 100
    [MouseClicker]::mouse_event(2, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 50
    [MouseClicker]::mouse_event(4, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 300
    $shell.SendKeys('^v')
    Start-Sleep -Milliseconds 500

    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($chrome.MainWindowHandle)
    $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    )

    $deadline = (Get-Date).AddSeconds(60)
    $sent = $false
    while ((Get-Date) -lt $deadline -and -not $sent) {
      $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
      foreach ($button in $buttons) {
        $name = $button.Current.Name
        if (
          $button.Current.IsEnabled -and
          $button.Current.BoundingRectangle.Width -gt 0 -and
          $button.Current.BoundingRectangle.Height -gt 0 -and
          ($name -match 'Enviar|Send|Submit')
        ) {
          try {
            $invokePattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $invokePattern.Invoke()
            $sent = $true
            break
          } catch {
            $rect = $button.Current.BoundingRectangle
            $clickX = [int]($rect.Left + ($rect.Width / 2))
            $clickY = [int]($rect.Top + ($rect.Height / 2))
            [MouseClicker]::SetCursorPos($clickX, $clickY) | Out-Null
            Start-Sleep -Milliseconds 100
            [MouseClicker]::mouse_event(2, 0, 0, 0, 0)
            Start-Sleep -Milliseconds 50
            [MouseClicker]::mouse_event(4, 0, 0, 0, 0)
            $sent = $true
            break
          }
        }
      }
      if (-not $sent) { Start-Sleep -Milliseconds 500 }
    }

    if (-not $sent) {
      $shell.SendKeys('{ENTER}')
    }
  `;

  try {
    await runPowerShell(sendScript, 90000);
    debugLog('Colei no ChatGPT e enviei quando o botao ficou disponivel.');
  } catch {
    debugLog('Nao consegui focar o Chrome. O prompt ja esta copiado; cole manualmente.');
    return '';
  }

  let lastCopiedText = '';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await page.waitForTimeout(2000);
    lastCopiedText = await copyChromePageText().catch(() => '');
    if (extractAnswersFromChatText(lastCopiedText).length > 0) {
      debugLog(`Resposta do ChatGPT encontrada na tentativa ${attempt}.`);
      return lastCopiedText;
    }
  }

  debugLog('Copiei o texto da pagina, mas ainda nao encontrei uma linha RESPOSTAS valida.');
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
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
    if ([WindowFocus]::IsIconic($chrome.MainWindowHandle)) {
      [WindowFocus]::ShowWindowAsync($chrome.MainWindowHandle, 9) | Out-Null
      Start-Sleep -Milliseconds 300
    }
    [WindowFocus]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 500
    $activated = $shell.AppActivate([int]$chrome.Id)
    if (-not $activated) { exit 2 }
    Start-Sleep -Milliseconds 300
    $foreground = [WindowFocus]::GetForegroundWindow()
    $foregroundPid = 0
    [WindowFocus]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) | Out-Null
    if ($foregroundPid -ne $chrome.Id) {
      [WindowFocus]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
      Start-Sleep -Milliseconds 500
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

async function runPowerShell(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell excedeu ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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
  await applyParsedAnswers(answers, { finalize: startMode === 'avaliacao' });
}

async function applyParsedAnswers(answers, options = {}) {
  const shouldFinalize = options.finalize ?? true;
  const exerciseReturnUrl = options.exerciseReturnUrl || '';
  if (!answers.length) throw new Error('nao encontrei respostas para marcar');

  await focusExamBrowserWindow();
  await page.bringToFront().catch(() => {});
  lastRead = await collectExam();
  debugLog(`Vou marcar automaticamente: ${answers.map((answer) => answer.letter).join(' ')}`);

  let markedCount = 0;
  if (!shouldFinalize) {
    for (const answer of answers) {
      const result = await clickAnswerWithLocators(answer.questionNumber, answer.letter);

      if (result.ok) {
        markedCount += 1;
        debugLog(`Marcada: questao ${answer.questionNumber}, alternativa ${answer.letter}.`);
      } else {
        debugLog(`Nao marcou questao ${answer.questionNumber}: ${result.reason}`);
      }
    }

    if (answers.length < 10) {
      debugLog('Nao finalizei o exercicio porque detectei menos de 10 respostas.');
      return;
    }

    debugLog(`Exercicio respondido automaticamente (${markedCount}/${answers.length}).`);
    await finishExerciseAndReturnToList(exerciseReturnUrl);
    return;
  }

  for (const answer of answers) {
    const result = await markAnswerAndConfirm(answer.questionNumber, answer.letter);

    if (result.ok) {
      markedCount += 1;
      debugLog(`Marcada: questao ${answer.questionNumber}, alternativa ${answer.letter}.`);
    } else {
      debugLog(`Nao marcou questao ${answer.questionNumber}: ${result.reason}`);
    }
  }

  if (answers.length < 10) {
    debugLog('Nao finalizei porque detectei menos de 10 respostas.');
    return;
  }

  const answeredCount = await getAnsweredCount();
  if (answeredCount < 10) {
    debugLog(`Nao finalizei porque o painel ainda mostra Respondidas (${answeredCount}).`);
    return;
  }

  await finishExamWithToken();
}

async function markAnswerAndConfirm(questionNumber, letter) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await clickAnswerWithLocators(questionNumber, letter);
    await page.waitForTimeout(700);
    const checked = await isQuestionAnsweredWithLetter(questionNumber, letter);

    if (result.ok && checked) {
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

async function isQuestionAnsweredWithLetter(questionNumber, letter) {
  return page.evaluate(`(() => {
    ${browserHelpersSource()}
    const roots = findQuestionRoots();
    const root =
      document.querySelector('[data-testid="question-${questionNumber}"]') ||
      roots.find((candidate, index) => {
        const match = textOf(candidate).match(/(?:^|\\n)\\s*(\\d{1,2})\\s*(?:\\n|$)/);
        const parsed = match ? Number(match[1]) : null;
        return parsed === ${questionNumber} || (parsed === null && index + 1 === ${questionNumber});
      });
    if (!root) return false;

    const optionRoot = findOptionRoot(root, ${JSON.stringify(letter)});
    if (!optionRoot) return false;

    const selectedSelector = [
      'input[type="radio"]:checked',
      'input[type="checkbox"]:checked',
      '[aria-checked="true"]',
      '[aria-selected="true"]',
      '[data-state="checked"]',
      '[data-checked="true"]',
    ].join(',');
    if (optionRoot.matches?.(selectedSelector) || optionRoot.querySelector(selectedSelector)) return true;

    const checkedInput = root.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked');
    if (checkedInput && optionRoot.contains(checkedInput)) return true;

    return false;
  })()`).catch(() => false);
}

async function finishExerciseAndReturnToList(returnToListUrl = '') {
  await focusExamBrowserWindow();
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(800);

  const finishButton = await waitForAnyVisible([
    'button[data-element="button_finalizar-prova"]',
    'button[data-element="button_finalizar-prova"]:has-text("Finalizar exercícios")',
    'button[data-element="button_finalizar-prova"]:has-text("Finalizar exercicios")',
    'button[aria-label="Finalizar exercícios"]',
    'button[aria-label="Finalizar exercicios"]',
    'button.css-18p9o19:has-text("Finalizar exercícios")',
    'button.css-18p9o19:has-text("Finalizar exercicios")',
  ], 15000);

  if (finishButton) {
    await finishButton.click({ force: true });
  } else {
    const clicked = await clickButtonByNormalizedText('finalizar exercicios');
    if (!clicked) {
      debugLog('Exercicio respondido, mas nao encontrei o botao Finalizar exercicios.');
      return;
    }
  }

  await page.waitForTimeout(1000);

  const submitButton = await waitForAnyVisible([
    'button[data-testid="submit-button"]',
    'button[data-testid="submit-button"]:has-text("Finalizar exercícios")',
    'button[data-testid="submit-button"]:has-text("Finalizar exercicios")',
    'button.css-18p9o19:has-text("Finalizar exercícios")',
    'button.css-18p9o19:has-text("Finalizar exercicios")',
  ], 15000);

  if (submitButton) {
    await submitButton.click({ force: true });
  } else {
    const clicked = await clickButtonByNormalizedText('finalizar exercicios');
    if (!clicked) {
      debugLog('Cliquei em Finalizar exercicios, mas nao encontrei o botao do popup.');
      return;
    }
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);

  const exitButton = await waitForAnyVisible([
    'button[data-testid="exit-button-desktop"]',
    'button[data-element="button_sair"]',
    'button[data-info="button_sair"]',
    'button[aria-label="Sair"]',
  ], 15000);

  if (exitButton) {
    await exitButton.click({ force: true });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
  }

  const targetUrl = returnToListUrl || currentExerciseListUrl;
  if (targetUrl) {
    currentExerciseListUrl = targetUrl;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
  }
}

async function clickButtonByNormalizedText(targetText) {
  return page.evaluate((wantedText) => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const isVisible = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const isEnabled = (element) => (
      !element.disabled &&
      element.getAttribute('aria-disabled') !== 'true'
    );
    const button = [...document.querySelectorAll('button, [role="button"], a')]
      .filter(isVisible)
      .filter(isEnabled)
      .find((element) => normalize(element.innerText || element.textContent || element.getAttribute('aria-label')).includes(wantedText));
    if (!button) return false;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return true;
  }, normalizeText(targetText)).catch(() => false);
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
    debugLog('Respostas marcadas, mas nao encontrei o botao Finalizar prova.');
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
    debugLog('Cliquei em Finalizar prova, mas nao encontrei o token no modal.');
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
    debugLog(`Token encontrado (${token}), mas nao encontrei o campo para preencher.`);
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
    debugLog(`Preenchi o token ${token}, mas nao encontrei o botao final habilitado.`);
    return;
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  debugLog(`Prova finalizada com token ${token}.`);
  await returnToEvaluationsAndContinue();
}

async function returnToEvaluationsAndContinue() {
  await page.waitForTimeout(1200);

  const evaluationsButton = await waitForAnyVisible([
    'button:has(.css-18eckzp):has-text("Ir para")',
    'button:has-text("Ir para")',
    '[role="button"]:has-text("Ir para")',
    '.css-18eckzp',
  ], 5000);

  if (evaluationsButton) {
    const parentButton = evaluationsButton.locator('xpath=ancestor-or-self::button[1]').first();
    if (await parentButton.count().catch(() => 0)) {
      await parentButton.click({ force: true }).catch(() => {});
    } else {
      await evaluationsButton.click({ force: true }).catch(() => {});
    }
  } else {
    const clicked = await page.evaluate(() => {
      const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const candidates = [...document.querySelectorAll('button, [role="button"], a')];
      const button = candidates.find((element) => /Ir para avalia|Ir para/i.test(clean(element.innerText || element.textContent)));
      if (!button) return false;
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return true;
    });

    if (!clicked) {
      debugLog('Prova finalizada, mas nao encontrei o botao Ir para avaliacoes. Vou abrir a lista diretamente.');
      await openUrl(EVALUATIONS_URL);
    }
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1200);

  if (/saladeavaliacoes\.com\.br\/avaliacoes\/[^/?]+\/?/i.test(page.url())) {
    debugLog('Voltei para a pagina da mesma avaliacao. Vou revisar Simulados e Prova AV antes de avancar.');
    await clickSimuladosIfAvailable();
    return;
  }

  if (page.url().includes('estudante.estacio.br/avaliacoes')) {
    debugLog('Voltei para a lista. Vou reabrir a mesma avaliacao para verificar pendencias.');
    await accessEvaluationByIndex(currentEvaluationIndex).catch((error) => {
      debugLog(`Nao consegui reabrir a avaliacao atual: ${error.message}`);
    });
    return;
  }

  debugLog('Nao reconheci a pagina apos finalizar. Vou abrir a lista de avaliacoes e reabrir a mesma avaliacao.');
  await openUrl(EVALUATIONS_URL);
  await accessEvaluationByIndex(currentEvaluationIndex).catch((error) => {
    debugLog(`Nao consegui reabrir a avaliacao atual: ${error.message}`);
  });
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
  debugLog(`\nTitulo: ${read.title || '(nao detectado)'}`);
  debugLog(`Questoes detectadas: ${read.questions.length}`);
}

function buildAnswerPrompt(read) {
  const questions = read.questions.map((question) => ({
    questionNumber: question.number,
    statement: question.statement,
    options: question.options,
  }));
  const questionPayload = JSON.stringify(
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
  const title = read.title || currentExerciseTitle || '(titulo nao detectado)';
  return ANSWER_PROMPT_TEMPLATE
    .replaceAll('{ titulo prova }', title)
    .replace('{ questoes }', questionPayload);
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
  debugLog(`Clique executado: questao ${number}, alternativa ${letter}.`);
}

async function scrollPage(direction = 'baixo') {
  const amount = ['cima', 'up'].includes((direction ?? '').toLowerCase()) ? -650 : 650;
  await page.mouse.wheel(0, amount);
  await page.waitForTimeout(250);
  debugLog(amount > 0 ? 'Rolei para baixo.' : 'Rolei para cima.');
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
  debugLog(clicked ? `Tentei abrir a questao ${number}.` : `Nao encontrei botao de navegacao para a questao ${number}.`);
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
    const explicitTitle = [...document.querySelectorAll('.css-1yfjwh2, .css-1qsp6bi')]
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
  const byTestId = [...document.querySelectorAll('[data-testid^="question-"]')].filter(visible);
  if (byTestId.length > 0) return byTestId;

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
  if (roots.length > 0) return roots.filter(visible);

  const genericRoots = [...document.querySelectorAll('section, article, li, [class*="question"], [class*="questao"], [class*="pergunta"], div')]
    .filter(visible)
    .map((element) => ({ element, text: textOf(element) }))
    .filter(({ text }) => /quest(?:a|\u00e3)o\s*\d{1,2}|^\s*\d{1,2}\s+/i.test(text))
    .filter(({ text }) => /\bA\b/.test(text) && /\bB\b/.test(text) && /\bC\b/.test(text))
    .filter(({ text }) => text.length > 120 && text.length < 4000)
    .sort((a, b) => a.text.length - b.text.length)
    .map(({ element }) => element);

  const uniqueRoots = [];
  for (const root of genericRoots) {
    if (uniqueRoots.some((existing) => existing.contains(root))) continue;
    uniqueRoots.push(root);
  }
  return uniqueRoots;
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
  return { ok: true };
}

function clickOptionByQuestionTestId(number, letter) {
  const root = document.querySelector(`[data-testid="question-${number}"]`);
  if (!root) return { ok: false, reason: `nao encontrei data-testid question-${number}` };

  const optionRoot = findOptionRoot(root, letter);
  if (!optionRoot) return { ok: false, reason: `nao encontrei a alternativa ${letter} dentro de question-${number}` };

  optionRoot.scrollIntoView({ block: 'center', inline: 'center' });
  optionRoot.click();
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
  currentEvaluationIndex = 0;
  await openUrl(EVALUATIONS_URL);
  await accessFirstEvaluation();
}

async function accessFirstEvaluation() {
  await accessEvaluationByIndex(currentEvaluationIndex);
}

async function accessEvaluationByIndex(index) {
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

  const evaluationButton = await waitForEvaluationButtonByIndex(index, selectors, 30000);
  if (evaluationButton) {
    await evaluationButton.click();
  } else {
    const clicked = await page.evaluate((targetIndex) => {
      const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const candidates = [...document.querySelectorAll('button, a, [role="button"], div, span, p')]
        .filter((element) => /^Avaliações$/i.test(clean(element.innerText || element.textContent)));

      for (const candidate of candidates.slice(targetIndex, targetIndex + 1)) {
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
    }, index);

    if (!clicked) {
      throw new Error(`nao encontrei btn-acessar-avaliacoes para a avaliacao ${index + 1}`);
    }
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForURL(/saladeavaliacoes\.com\.br\/avaliacoes\/[^/?]+\/?/, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2500);
  debugLog(`Acessei a avaliacao ${index + 1}: ${page.url()}`);
  await clickSimuladosIfAvailable();
}

async function waitForEvaluationButtonByIndex(index, selectors, totalTimeoutMs) {
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      try {
        const count = await locator.count();
        if (count > index) {
          const button = locator.nth(index);
          if (await button.isVisible({ timeout: 500 })) return button;
        }
      } catch {
        // Tenta o proximo seletor.
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
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
    debugLog('Nao encontrei a opcao Simulados no sidebar.');
    await clickProvaAvAndAccessOnline();
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
    debugLog('Encontrei Simulados no sidebar, mas nao encontrei o botao button_avaliacao-Simulado.');
    await clickProvaAvAndAccessOnline();
    return;
  }

  await button.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  debugLog(`Cliquei em Simulados: ${page.url()}`);
  const accessedSimulation = await accessFirstPendingSimulation();
  if (!accessedSimulation) {
    debugLog('Nao ha simulado disponivel para acessar. Vou tentar Prova AV.');
    await clickProvaAvAndAccessOnline();
  }
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
    debugLog(result.reason);
    return false;
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  debugLog(`Cliquei no simulado disponivel (${result.label}): ${page.url()}`);
  await handleSimulationAfterAccess();
  return true;
}

async function clickProvaAvAndAccessOnline() {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(800);

  const provaAvButton = await waitForAnyVisible([
    '[data-element="button_avaliacao-Prova AV"]',
    '[data-testid="evaluation-type-Prova AV-test-id"]',
    '[data-testid="button_avaliacao-Prova AV"]',
    'button[title="Prova AV"]',
    'button:has-text("Prova AV")',
    '[role="button"]:has-text("Prova AV")',
  ], 12000);

  if (provaAvButton) {
    await provaAvButton.click();
  } else {
    const clicked = await page.evaluate(() => {
      const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const isVisible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const sidebars = [...document.querySelectorAll('.sidebar-box-wrapper, [class*="sidebar-box-wrapper"], aside, nav')];
      const candidates = sidebars.length > 0 ? sidebars.flatMap((sidebar) => [...sidebar.querySelectorAll('button, [role="button"], a, div, span')]) : [...document.querySelectorAll('button, [role="button"], a')];
      const element = candidates.find((candidate) => isVisible(candidate) && /^Prova AV$/i.test(clean(candidate.innerText || candidate.textContent)));
      const clickable = element?.closest('button, [role="button"], a') || element;
      if (!clickable) return false;
      clickable.scrollIntoView({ block: 'center', inline: 'center' });
      clickable.click();
      return true;
    });

    if (!clicked) {
      statusEvaluation('Finalizada');
      await goToNextEvaluation();
      return;
    }
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  debugLog(`Cliquei em Prova AV: ${page.url()}`);

  const result = await accessOnlineProvaAvCard();
  if (!result.ok) {
    statusEvaluation('Finalizada');
    await goToNextEvaluation();
    return;
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  debugLog(`Cliquei na Prova AV online (${result.label}): ${page.url()}`);
  await handleSimulationAfterAccess();
}

async function goToNextEvaluation() {
  const nextIndex = currentEvaluationIndex + 1;

  const backButton = await waitForAnyVisible([
    'button.css-lh6f9h',
    '.css-lh6f9h',
    'button[aria-label*="Voltar" i]',
    '[role="button"][aria-label*="Voltar" i]',
    'button:has-text("Voltar")',
    '[role="button"]:has-text("Voltar")',
  ], 8000);

  if (backButton) {
    await backButton.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
    debugLog('Cliquei em voltar para escolher a proxima avaliacao.');
  } else {
    debugLog('Nao encontrei o botao voltar; vou abrir a lista de avaliacoes diretamente.');
  }

  if (!page.url().includes('estudante.estacio.br/avaliacoes')) {
    await openUrl(EVALUATIONS_URL);
  }

  await page.waitForFunction(() => document.body?.innerText?.includes('Minhas Disciplinas'), null, { timeout: 30000 }).catch(() => {});
  const totalEvaluations = await countEvaluationButtons();
  if (nextIndex >= totalEvaluations) {
    await shutdownAndExit();
    return;
  }

  currentEvaluationIndex = nextIndex;
  debugLog(`Vou tentar a proxima avaliacao: quadrado ${currentEvaluationIndex + 1}.`);
  await accessEvaluationByIndex(currentEvaluationIndex);
}

async function countEvaluationButtons() {
  const selectors = [
    '[data-testid="btn-acessar-avaliacoes"]',
    '#btn-acessar-avaliacoes',
    '.btn-acessar-avaliacoes',
    'button.btn-acessar-avaliacoes',
    'a.btn-acessar-avaliacoes',
  ];

  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) return count;
  }

  return page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('button, a, [role="button"], div, span, p')]
      .filter((element) => /^Avalia(?:c|\u00e7)(?:o|\u00f5)es$/i.test(clean(element.innerText || element.textContent)))
      .length;
  }).catch(() => 0);
}

async function shutdownAndExit() {
  clearInterval(chatMinimizer);
  rl.close();
  await context.close().catch(() => {});
  await cleanupFirefoxSessionState();
  process.exit(0);
}

async function accessOnlineProvaAvCard() {
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

    const cards = [...document.querySelectorAll('.lft-cardshape, [class*="lft-cardshape"], section, article, li, div')]
      .filter(isVisible)
      .map((element) => ({ element, text: clean(element.innerText || element.textContent) }))
      .filter(({ text }) => /Online/i.test(text) && text.length > 20 && text.length < 1800)
      .filter(({ element }) => element.querySelector('.css-1mvqbuv, [class*="css-1mvqbuv"], button, a, [role="button"], .css-1ujby1e'))
      .sort((a, b) => {
        const priority = ({ text }) => {
          if (/N(?:a|\u00e3)o realizada|Acessar|Continuar|Retomar/i.test(text) && !/gabarito/i.test(text)) return 0;
          if (!/Realizada em|Acessar gabarito/i.test(text)) return 1;
          return 9;
        };
        return priority(a) - priority(b) || a.text.length - b.text.length;
      });

    for (const { element: card, text: cardText } of cards) {
      const hasOnlineBadge =
        [...card.querySelectorAll('.css-1mvqbuv, [class*="css-1mvqbuv"], span, div')]
          .some((element) => isVisible(element) && /^Online$/i.test(clean(element.innerText || element.textContent))) ||
        /\bOnline\b/i.test(cardText);
      if (!hasOnlineBadge) continue;
      if (/Acessar gabarito/i.test(cardText)) continue;

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

    return { ok: false, reason: 'Nao encontrei card online de Prova AV com botao Acessar, Continuar ou Retomar.' };
  });

  return result;
}

async function handleSimulationAfterAccess() {
  if (await waitForExamQuestionsReady(5000)) {
    debugLog('A prova ja estava aberta. Vou executar o comando prompt automaticamente.');
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

  debugLog('Acessei o simulado, mas ainda nao encontrei a tela de orientacoes nem as questoes.');
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
    debugLog(accepted.reason || 'Nao consegui marcar as duas checkbox de orientacao.');
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
      debugLog('Checkboxes marcadas, mas nao encontrei o botao Comecar Prova.');
      return;
    }
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);
  debugLog(`Comecei a prova: ${page.url()}`);
  await runPromptAutomaticallyAfterExamStart();
}

async function runPromptAutomaticallyAfterExamStart() {
  const ready = await waitForExamQuestionsReady(30000);
  if (!ready) {
    debugLog('Prova iniciada, mas ainda nao encontrei as questoes para gerar o prompt automaticamente.');
    return;
  }

  debugLog('Questoes carregadas. Vou executar o comando prompt automaticamente.');
  await savePromptForChat({ finalize: true });
}

async function runExercisePromptAutomaticallyAfterStart(options = {}) {
  const ready = await waitForExamQuestionsReady(30000);
  if (!ready) {
    debugLog('Exercicio aberto, mas ainda nao encontrei as questoes para gerar o prompt automaticamente.');
    return;
  }

  debugLog('Questoes do exercicio carregadas. Vou executar o comando prompt automaticamente.');
  await savePromptForChat({ finalize: false, exerciseReturnUrl: options.returnToListUrl || currentExerciseListUrl });
}

async function waitForExamQuestionsReady(totalTimeoutMs) {
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return (
        !!document.querySelector('[data-testid^="question-"]') ||
        /Marcar para revis(?:a|\u00e3)o/i.test(text) ||
        /Quest(?:a|\u00e3)o\s*1/i.test(text) ||
        /Quest(?:a|\u00e3)o\s*1\s*de\s*10/i.test(text)
      );
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

  debugLog('Pagina de disciplinas aberta. Vou abrir avaliacoes e acessar a primeira prova.');
  await collectEvaluations();
}
