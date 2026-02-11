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

// ===== FIXED TRANSLATOR (CORRECT SELECTORS) =====
class Translator {
    constructor() {
        this.browser = null;
        this.page = null;
    }

    async init() {
        console.log('🚀 Launching Chrome for translation...');
        this.browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions'
            ]
        });

        this.page = await this.browser.newPage();
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        
        await this.page.goto('https://translate.google.com/?sl=zh-CN&tl=en&op=translate', {
            waitUntil: 'networkidle0',
            timeout: 30000
        });
        
        // Wait for textarea to be ready
        await this.page.waitForSelector('textarea[aria-label="Source text"]', { timeout: 15000 });
        console.log('✅ Translation engine ready');
    }

    async translate(text) {
        if (!text || text.trim().length < 2) return text;
        const cleanText = text.trim();
        
        try {
            // ===== INPUT: textarea with aria-label =====
            const textareaSel = 'textarea[aria-label="Source text"]';
            const outputSel = 'span.ryNqvb'; // Direct class selector (faster)

            // Clear textarea
            await this.page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.value = '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }, textareaSel);

            // Set text instantly
            await this.page.evaluate((sel, val) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.value = val;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }, textareaSel, cleanText);

            // Wait for translation to appear
            await this.page.waitForFunction(
                (sel) => {
                    const el = document.querySelector(sel);
                    return el && el.textContent.trim().length > 0 &&
                           !el.textContent.includes('...');
                },
                { timeout: 12000, polling: 150 },
                outputSel
            );

            // Extract translation
            const translated = await this.page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? el.textContent.trim() : '';
            }, outputSel);

            return translated && translated !== cleanText ? translated : cleanText;
            
        } catch (error) {
            console.warn(`⚠️ Translation failed: "${cleanText.substring(0, 30)}..."`);
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
    
    const extractTextNodes = (node) => {
        if (node.type === 'text' && node.data?.trim()) {
            textNodes.push({ node, original: node.data.trim() });
        }
        if (node.children) {
            node.children.forEach(extractTextNodes);
        }
    };
    
    $('div').contents().each((_, el) => extractTextNodes(el));
    
    if (textNodes.length === 0) return htmlContent;
    
    for (const item of textNodes) {
        item.node.data = await translator.translate(item.original);
    }
    
    return $('div').html();
}

// ===== MAIN CRAWLER =====
async function crawlNovel(startUrl, translate = true) {
    console.log(`\n🌐 Starting crawl: ${startUrl}`);
    
    if (!startUrl.startsWith('http')) startUrl = `https://${startUrl}`;
    const novelIdMatch = startUrl.match(/\/read\/(\d+)/);
    if (!novelIdMatch) throw new Error('Invalid URL format');
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
    console.log('📡 Fetching novel metadata...');
    const mainPageResponse = await axiosInstance.get(startUrl);
    const $main = cheerio.load(mainPageResponse.data);

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
    const latestChapterUrl = $main('ul.u-chapter.cfirst li a').first().attr('href');
    if (!latestChapterUrl) throw new Error('No chapters found');
    const latestChapterMatch = latestChapterUrl.match(/p(\d+)\.html/);
    if (!latestChapterMatch) throw new Error('Invalid chapter URL');
    const latestChapter = parseInt(latestChapterMatch[1], 10);
    
    const chapterUrls = Array.from({ length: latestChapter }, (_, i) =>
        `${baseUrl}/read/${novelId}/p${latestChapter - i}.html`
    );

    console.log(`📚 Found ${chapterUrls.length} chapters: "${novelTitle}" by ${author}`);

    // Setup output
    const resultDir = path.join(__dirname, '../results');
    await mkdir(resultDir, { recursive: true });
    const outputFile = path.join(resultDir, `${novelId}.json`);
    const chapters = [];

    // Download chapters
    console.log(`📥 Downloading chapters (concurrency: 15)...`);
    const queue = new PQueue({ concurrency: 15 });
    let completed = 0;
    
    await Promise.all(chapterUrls.map((url, index) =>
        queue.add(async () => {
            try {
                const response = await axiosInstance.get(url);
                const $ = cheerio.load(response.data);
                $('script, style, iframe, noscript, .abg, .ad, .ads, .hidden').remove();
                
                let title = $('article.page-content > h3').first().text().trim() || `Chapter ${chapterUrls.length - index}`;
                const paragraphs = [];
                
                $('article.page-content section p').each((_, el) => {
                    const $p = $(el);
                    if ($p.hasClass('abg') || $p.parents('.ad, .ads').length) return;
                    const html = $p.html()?.trim();
                    if (html && html.length > 5) paragraphs.push(`<p>${html}</p>`);
                });
                
                const content = paragraphs.join('\n') || '<p>Content unavailable</p>';
                const chapterNumber = chapterUrls.length - index;
                chapters[chapterNumber - 1] = { title, content };
            } catch (error) {
                console.error(`\n❌ Error at ${url}: ${error.message}`);
            } finally {
                completed++;
                process.stdout.write(`\r📥 ${completed}/${chapterUrls.length} chapters`);
            }
        })
    ));
    
    console.log(`\n✅ Downloaded ${chapters.filter(c => c).length} chapters`);

    // TRANSLATION PHASE
    if (translate) {
        console.log('\n🌍 Starting translation...');
        const translator = new Translator();
        await translator.init();
        
        try {
            // Translate metadata
            console.log('🔤 Translating metadata...');
            const meta = {
                title: await translator.translate(novelTitle),
                author: await translator.translate(author),
                status: await translator.translate(status),
                description: await translator.translate(description),
                genres: []
            };
            
            for (const genre of genres) {
                meta.genres.push(await translator.translate(genre));
            }
            console.log('✅ Metadata translated');

            // Translate chapters
            console.log(`\n챕터 Translating ${chapters.length} chapters...`);
            for (let i = 0; i < chapters.length; i++) {
                if (!chapters[i]) continue;
                
                const chapter = chapters[i];
                console.log(`챕터 [${i + 1}/${chapters.length}] "${chapter.title.substring(0, 40)}..."`);
                
                chapter.title = await translator.translate(chapter.title);
                chapter.content = await translateChapterContent(chapter.content, translator);
                
                if (i < chapters.length - 1) {
                    await new Promise(res => setTimeout(res, 300));
                }
            }
            
            console.log('✅ All chapters translated');
            await translator.close();
            
            // Save output
            const finalOutput = {
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
            
            await writeFile(outputFile, JSON.stringify(finalOutput, null, 2), 'utf8');
            console.log(`\n✅ Saved to: ${outputFile}`);
            return outputFile;
            
        } catch (error) {
            await translator.close();
            throw error;
        }
    } else {
        // Save without translation
        const finalOutput = {
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
        
        await writeFile(outputFile, JSON.stringify(finalOutput, null, 2), 'utf8');
        console.log(`\n✅ Saved original to: ${outputFile}`);
        return outputFile;
    }
}

// ===== EXECUTION =====
const url = process.argv[2] || process.env.INPUT_URL;
const shouldTranslate = process.argv[3] === 'translate' || process.env.TRANSLATE === 'true';

if (!url) {
    console.error('Usage: node crawler.js <novel-url> [translate]');
    console.error('Example: node crawler.js https://ixdzs.tw/read/620883/ translate');
    process.exit(1);
}

crawlNovel(url, shouldTranslate)
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\n💥 Fatal error:', err.message);
        process.exit(1);
    });
