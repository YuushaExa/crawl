const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { promisify } = require('util');
const { default: PQueue } = require('p-queue');
const puppeteer = require('puppeteer');

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

// ===== WORKING TRANSLATOR (SIMULATES REAL USER INTERACTION) =====
class Translator {
    constructor() {
        this.browser = null;
        this.page = null;
    }

    async init() {
        console.log('🚀 Launching Chrome...');
        this.browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--lang=en-US,en'
            ]
        });

        this.page = await this.browser.newPage();
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        
        // CRITICAL: Force desktop viewport (prevents mobile UI)
        await this.page.setViewport({ width: 1280, height: 800 });
        
        // Navigate to clean translate page
        await this.page.goto('https://translate.google.com/?sl=zh-CN&tl=en&op=translate', {
            waitUntil: 'networkidle0',
            timeout: 30000
        });
        
        // Wait for textarea to be truly interactable
        await this.page.waitForSelector('textarea[aria-label="Source text"]', { 
            visible: true, 
            timeout: 15000 
        });
        
        console.log('✅ Ready for translation');
    }

    async translate(text) {
        if (!text || text.trim().length < 2) return text;
        const cleanText = text.trim().substring(0, 5000); // Google has limits
        
        try {
            const textareaSel = 'textarea[aria-label="Source text"]';
            const resultSel = 'span.ryNqvb';

            // 1. CLICK to focus textarea (MANDATORY for Google)
            await this.page.click(textareaSel, { clickCount: 3 }); // Triple-click selects all
            await this.page.keyboard.press('Backspace'); // Clear
            
            // 2. TYPE slowly (triggers real input events Google expects)
            await this.page.type(textareaSel, cleanText, { delay: 15 }); // 15ms/char is safe
            
            // 3. Wait for translation to appear
            await this.page.waitForFunction(
                (sel) => {
                    const el = document.querySelector(sel);
                    return el && el.textContent.trim().length > 0 &&
                           !['...', '⋯', 'Translating'].includes(el.textContent.trim());
                },
                { timeout: 15000, polling: 200 },
                resultSel
            );

            // 4. Extract result
            const translated = await this.page.evaluate((sel) => {
                return document.querySelector(sel)?.textContent.trim() || '';
            }, resultSel);

            return translated && translated.length > 2 ? translated : cleanText;
            
        } catch (error) {
            console.warn(`⚠️ Failed: "${cleanText.substring(0, 30)}..."`);
            // DEBUG: Uncomment to see what's happening
            // await this.page.screenshot({ path: `error-${Date.now()}.png` });
            return cleanText;
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            console.log('✅ Chrome closed');
        }
    }
}

// ===== HTML-PRESERVING TRANSLATION =====
async function translateChapterContent(htmlContent, translator) {
    if (!htmlContent?.trim()) return htmlContent;
    
    const $ = cheerio.load(`<div>${htmlContent}</div>`, { decodeEntities: false });
    const textNodes = [];
    
    const extract = (node) => {
        if (node.type === 'text' && node.data?.trim()) {
            textNodes.push({ node, text: node.data.trim() });
        }
        if (node.children) node.children.forEach(extract);
    };
    
    $('div').contents().each((_, el) => extract(el));
    if (!textNodes.length) return htmlContent;
    
    for (const item of textNodes) {
        item.node.data = await translator.translate(item.text);
    }
    
    return $('div').html();
}

// ===== MAIN CRAWLER (UNCHANGED CORE LOGIC) =====
async function crawlNovel(startUrl, translate = true) {
    console.log(`\n🌐 Starting: ${startUrl}`);
    
    if (!startUrl.startsWith('http')) startUrl = `https://${startUrl}`;
    const novelIdMatch = startUrl.match(/\/read\/(\d+)/);
    if (!novelIdMatch) throw new Error('Invalid URL');
    const novelId = novelIdMatch[1];
    const baseUrl = new URL(startUrl).origin;

    const axiosInstance = axios.create({
        timeout: 15000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
        }
    });

    // Fetch metadata
    console.log('📡 Fetching metadata...');
    const res = await axiosInstance.get(startUrl);
    const $main = cheerio.load(res.data);

    const novelTitle = $main('.n-text h1').first().text().trim() || 'Untitled';
    const cover = $main('.n-img img').attr('src') || '';
    const author = $main('.n-text p a.bauthor').first().text().trim() || 'Unknown';
    const authorUrl = $main('.n-text p a.bauthor').attr('href') 
        ? new URL($main('.n-text p a.bauthor').attr('href'), startUrl).href 
        : null;
    
    let status = 'Unknown';
    if ($main('.n-text p .lz').length) status = $main('.n-text p .lz').text().trim();
    else if ($main('.n-text p .end').length) status = $main('.n-text p .end').text().trim();
    
    const description = $main('#intro').text().trim() || '';
    const genres = [];
    $main('.tags em a').each((_, el) => {
        const tag = $main(el).text().trim();
        if (tag) genres.push(tag);
    });

    // Get chapters
    const latestUrl = $main('ul.u-chapter.cfirst li a').first().attr('href');
    if (!latestUrl) throw new Error('No chapters');
    const match = latestUrl.match(/p(\d+)\.html/);
    if (!match) throw new Error('Invalid chapter URL');
    const latest = parseInt(match[1], 10);
    
    const chapterUrls = Array.from({ length: latest }, (_, i) =>
        `${baseUrl}/read/${novelId}/p${latest - i}.html`
    );

    console.log(`📚 ${chapterUrls.length} chapters: "${novelTitle}"`);

    // Setup output
    const resultDir = path.join(__dirname, '../results');
    await mkdir(resultDir, { recursive: true });
    const outputFile = path.join(resultDir, `${novelId}.json`);
    const chapters = [];

    // Download chapters
    console.log(`📥 Downloading (${chapterUrls.length} chapters)...`);
    const queue = new PQueue({ concurrency: 15 });
    let completed = 0;
    
    await Promise.all(chapterUrls.map((url, idx) =>
        queue.add(async () => {
            try {
                const res = await axiosInstance.get(url);
                const $ = cheerio.load(res.data);
                $('script, style, iframe, noscript, .abg, .ad, .ads, .hidden').remove();
                
                let title = $('article.page-content > h3').first().text().trim() || `Chapter ${chapterUrls.length - idx}`;
                const paragraphs = [];
                
                $('article.page-content section p').each((_, el) => {
                    const $p = $(el);
                    if ($p.hasClass('abg') || $p.parents('.ad, .ads').length) return;
                    const html = $p.html()?.trim();
                    if (html && html.length > 5) paragraphs.push(`<p>${html}</p>`);
                });
                
                const content = paragraphs.join('\n') || '<p>Content unavailable</p>';
                chapters[chapterUrls.length - 1 - idx] = { title, content };
            } catch (e) {
                console.error(`\n❌ ${url}: ${e.message}`);
            } finally {
                completed++;
                process.stdout.write(`\r📥 ${completed}/${chapterUrls.length}`);
            }
        })
    ));
    
    console.log(`\n✅ Downloaded ${chapters.filter(c => c).length} chapters`);

    // TRANSLATION
    if (translate) {
        console.log('\n🌍 Translating...');
        const translator = new Translator();
        await translator.init();
        
        try {
            // Metadata
            console.log('🔤 Metadata...');
            const meta = {
                title: await translator.translate(novelTitle),
                author: await translator.translate(author),
                status: await translator.translate(status),
                description: await translator.translate(description),
                genres: []
            };
            for (const g of genres) meta.genres.push(await translator.translate(g));
            console.log('✅ Metadata done');

            // Chapters
            console.log(`\n챕터 Translating ${chapters.length} chapters...`);
            for (let i = 0; i < chapters.length; i++) {
                if (!chapters[i]) continue;
                console.log(`챕터 [${i+1}/${chapters.length}] "${chapters[i].title.substring(0, 30)}..."`);
                
                chapters[i].title = await translator.translate(chapters[i].title);
                chapters[i].content = await translateChapterContent(chapters[i].content, translator);
                
                if (i < chapters.length - 1) await new Promise(r => setTimeout(r, 400));
            }
            
            await translator.close();
            
            // Save
            const out = {
                meta: {
                    id: novelId,
                    title: meta.title,
                    cover,
                    author: meta.author,
                    authorUrl,
                    status: meta.status,
                    description: meta.description,
                    genres: meta.genres,
                    totalChapters: chapters.filter(c => c).length,
                    sourceUrl: startUrl
                },
                chapters: chapters.filter(c => c)
            };
            
            await writeFile(outputFile, JSON.stringify(out, null, 2), 'utf8');
            console.log(`\n✅ Saved: ${outputFile}`);
            return outputFile;
            
        } catch (e) {
            await translator.close();
            throw e;
        }
    } else {
        // Save original
        const out = {
            meta: {
                id: novelId,
                title: novelTitle,
                cover,
                author,
                authorUrl,
                status,
                description,
                genres,
                totalChapters: chapters.filter(c => c).length,
                sourceUrl: startUrl
            },
            chapters: chapters.filter(c => c)
        };
        
        await writeFile(outputFile, JSON.stringify(out, null, 2), 'utf8');
        console.log(`\n✅ Saved: ${outputFile}`);
        return outputFile;
    }
}

// ===== RUN =====
const url = process.argv[2] || process.env.INPUT_URL;
const shouldTranslate = process.argv[3] === 'translate' || process.env.TRANSLATE === 'true';

if (!url) {
    console.error('Usage: node crawler.js <url> [translate]');
    process.exit(1);
}

crawlNovel(url, shouldTranslate)
    .catch(err => {
        console.error('\n💥 Error:', err.message);
        process.exit(1);
    });
