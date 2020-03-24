import { launch, Browser } from 'puppeteer';
import * as fs from 'fs';
import * as util from 'util';
import * as config from 'config';
import * as ora from 'ora';

const spinner = ora('Initiating process').start();

const access = util.promisify(fs.access);
const mkdir = util.promisify(fs.mkdir);
const setTimeoutPromise = util.promisify(setTimeout);

const COURSE_URLS: string[] = config.get('courseUrls');
const EMAIL: string = config.get('email');
const PASSWORD: string = config.get('password');
const MAKE_PDF: boolean = config.get('pdf');
const HTTP_REQUEST_TIMEOUT = 30000; // In ms

const ROOT_PATH = __dirname + '/../../';

let SAVE_DESTINATION = '';

let browser: Browser;

interface PageTitleAndLink {
  title: string;
  link: string;
}

async function main(): Promise<void> {
  if (COURSE_URLS.length < 1) {
    console.log('Set course url first.');
    return;
  }

  browser = await launch({ userDataDir: ROOT_PATH + '/data', headless: true });

  const loggedIn = await isLoggedIn();
  if (!loggedIn) {
    await login();
  } else {
    spinner.text = 'Already logged in.';
  }

  for (const COURSE_URL of COURSE_URLS) {
    spinner.text = 'Download in proguress. Course URL => ' + COURSE_URL;

    const pageLinks: PageTitleAndLink[] = await fetchCourseAndFindPageLinks(COURSE_URL);

    spinner.text = 'Total lessons found: ' + pageLinks.length;

    let i = 1;
    let promises = [];
    let doToggleMenu = true;
    for (const page of pageLinks) {
      try {
        if (i % 5 === 0 || i === pageLinks.length) {
          doToggleMenu = false;
          spinner.text = `Processing batch of lessons.`;
          await Promise.all(promises.map((p) => p.catch((e: Error) => console.error(e.message))));
          promises = [];
        }

        promises.push(downloadPage(`${i}.${page.title}`, page.link, doToggleMenu));
        i++;
      } catch (error) {
        console.error(error.message);
      }
    }

    // Wait for pending promises to resolve
    await Promise.all(promises);

  }

  await browser.close();

  spinner.stop();
}

async function isDireectoryExists(path: string): Promise<boolean> {
  try {
    await access(path, fs.constants.F_OK);
  } catch (error) {
    return false;
  }

  return true;
}

async function fetchCourseAndFindPageLinks(COURSE_URL: string): Promise<PageTitleAndLink[]> {
  spinner.text = 'Navigating to courses page. URL: ' + COURSE_URL;
  const page = await browser.newPage();

  await page.goto(COURSE_URL, { timeout: HTTP_REQUEST_TIMEOUT, waitUntil: 'networkidle0' });
  const title = (await page.title()).replace(/[&\/\\#,+()$~%.'":*?<>{}]/g, '_');

  // Create downloads folder
  if (!(await isDireectoryExists(`${ROOT_PATH}/downloads`))) {
    await mkdir(`${ROOT_PATH}/downloads`);
  }

  spinner.text = 'Creating course directory.';
  // Create course folder
  if (!(await isDireectoryExists(`${ROOT_PATH}/downloads/${title}`))) {
    await mkdir(`${ROOT_PATH}/downloads/${title}`);
  }

  SAVE_DESTINATION = ROOT_PATH + '/downloads/' + title;

  spinner.text = 'Looking for lessons\'s urls.';
  const pageLinks = await page.evaluate(() => {
    const links: HTMLAnchorElement[] = Array.from(document.querySelectorAll('.tab-content a'));
    return links.map((link) => {
      return {
        title: link.innerText,
        link: link.href
      };
    });
  });

  await page.close();

  return pageLinks;
}

async function downloadPage(title: string, link: string, doToggleMenu: boolean): Promise<void> {
  const normalizedTitle = title.replace(/[^a-zA-Z0-9]/g, '_');

  const page = await browser.newPage();

  await page.goto(link, { timeout: HTTP_REQUEST_TIMEOUT, waitUntil: 'networkidle0' });

  await page.addStyleTag({ content: 'div[class^="styles__PrevNextButtonWidgetStyled"], div[class^="styles__Footer"], nav { display: none !important; }' });

  if (MAKE_PDF) {
    try {
      await page.evaluate(() => {
        const node = document.getElementById('view-collection-article-content-root');
        node.childNodes[0].childNodes[0].childNodes[0].remove();
      });
    } catch (error) {
      console.error(error.message);
    }

    await page.emulateMediaType('screen');
    await page.pdf({
      path: `${SAVE_DESTINATION}/${normalizedTitle}.pdf`,
      printBackground: true,
      format: 'A4',
      margin: {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      }
    });
  } else {
    if (doToggleMenu) {
      await page.click('#sidebar-hamburger');
    }

    await setTimeoutPromise(300); // Wait for munu to close

    await page.screenshot({ path: `${SAVE_DESTINATION}/${normalizedTitle}.png`, fullPage: true });
    await page.close();
  }
}

async function login(): Promise<void> {
  spinner.text = 'Loggin in.';

  const page = await browser.newPage();
  await page.goto('https://www.educative.io', { timeout: HTTP_REQUEST_TIMEOUT, waitUntil: 'networkidle2' });
  await page.click('.MuiButton-label');
  await page.type('#loginform-email', EMAIL);
  await page.type('#loginform-password', PASSWORD);

  await setTimeoutPromise(2000);

  await page.click('#modal-login');

  const element = await page.waitForSelector("#alert span", { timeout: 10000 });
  const label = await page.evaluate((el: HTMLSpanElement) => el.innerText, element);

  if (label && label !== 'Signed in') {
    throw new Error(label);
  }

  await page.close();
}

async function isLoggedIn(): Promise<boolean> {
  spinner.text = 'Checking if already logged in.';

  const page = await browser.newPage();
  await page.goto('https://www.educative.io', { timeout: HTTP_REQUEST_TIMEOUT, waitUntil: 'networkidle2' });

  const element = await page.$('.MuiButton-outlined');
  let label: string;
  if (element) {
    label = await page.evaluate((el: HTMLSpanElement) => el.innerText, element);
  }

  await page.close();

  return label !== 'Log in';
}

/**
 * Run the main function
 */
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
