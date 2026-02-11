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

// ===== SINGLE BROWSER TRANSLATION MANAGER =====
class Translator {
    constructor() {
        this.browser = null;
        this.page = null;
    }

    async init() {
        console.log('Launching Chrome for translation...');
        this.browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--mute-audio',
                '--no-first-run',
                '--no-default-browser-check'
            ]
        });

        this.page = await this.browser.newPage();
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Navigate to Google Translate once
        await this.page.goto('https://translate.google.com/?sl=zh-CN&tl=en&op=translate', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        await this.page.waitForTimeout(2000);
        console.log('✅ Chrome ready for translation');
    }

    async translate(text) {
        if (!text || text.trim().length === 0) return text;
        
        try {
            const textareaSelector = 'textarea[aria-label="Source text"]';
            const resultSelector = 'span[class*="ryNqvb"]';

            // Clear textarea
            await this.page.click(textareaSelector, { clickCount: 3 });
            await this.page.keyboard.press('Backspace');
            
            // Type text
            await this.page.type(textareaSelector, text, { delay: 5 });
            
            // Wait for translation
            await this.page.waitForTimeout(2000);
            
            // Get result
            await this.page.waitForSelector(resultSelector, { timeout: 10000 });
            
            const translated = await this.page.evaluate((sel) => {
                const elements = document.querySelectorAll(sel);
                return Array.from(elements)
                    .map(el => el.textContent)
                    .join(' ');
            }, resultSelector);

            return translated.trim() || text;

        } catch (error) {
            console.error(`Translation error: ${error.message}`);
            return text;
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            console.log('✅ Chrome closed');
        }
    }
}

// ===== TRANSLATE CHAPTER CONTENT (preserving HTML structure) =====
async function translateChapterContent(htmlContent, translator) {
    if (!htmlContent || htmlContent.trim().length === 0) return htmlContent;
    
    const $ = cheerio.load(`<div>${htmlContent}</div>`);
    const paragraphs = [];
    
    // Extract and translate each paragraph separately
    $('p').each((_, el) => {
        const $p = $(el);
        const text = $p.text().trim();
        
        if (text && text.length > 0) {
            paragraphs.push({
                el: $p,
                text: text
            });
        }
    });
    
    // Translate all paragraphs
    for (let i = 0; i < paragraphs.length; i++) {
        const translated = await translator.translate(paragraphs[i].text);
        paragraphs[i].el.text(translated);
        console.log(`   Translated paragraph ${i + 1}/${paragraphs.length}`);
    }
    
    // Rebuild HTML with translated content
    return $('div').html();
}

// ===== MAIN CRAWL FUNCTION =====
async function crawlNovel(startUrl, translate = true) {
    try {
        console.log(`Starting crawl for URL: ${startUrl}`);
        console.log(`Translation enabled: ${translate ? 'YES' : 'NO'}`);

        // Normalize URL
        if (!startUrl.startsWith('http')) {
            startUrl = `https://${startUrl}`;
        }

        const novelIdMatch = startUrl.match(/\/read\/(\d+)/);
        if (!novelIdMatch) throw new Error('Invalid URL format: must contain /read/ followed by digits');
        const novelId = novelIdMatch[1];

        const baseUrl = new URL(startUrl).origin;
        const axiosInstance = axios.create({
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Connection': 'keep-alive'
            }
        });

        // === FETCH THE MAIN PAGE ===
        console.log('Fetching novel page for metadata and chapter list...');
        const mainPageResponse = await axiosInstance.get(startUrl);
        const $main = cheerio.load(mainPageResponse.data);

        // --- Extract Metadata ---
        const novelTitle = $main('.n-text h1').first().text().trim() || 'Untitled';
        const cover = $main('.n-img img').attr('src') || '';
        const author = $main('.n-text p a.bauthor').first().text().trim() || 'Unknown';

        const authorUrlEl = $main('.n-text p a.bauthor').attr('href');
        const authorUrl = authorUrlEl ? new URL(authorUrlEl, startUrl).href : null;

        let status = 'Unknown';
        if ($main('.n-text p .lz').length) {
            status = $main('.n-text p .lz').text().trim();
        } else if ($main('.n-text p .end').length) {
            status = $main('.n-text p .end').text().trim();
        }

        const description = $main('#intro').text().trim() || '';

        const genres = [];
        $main('.tags em a').each((_, el) => {
            const tag = $main(el).text().trim();
            if (tag) genres.push(tag);
        });

        // --- Extract latest chapter number ---
        const latestChapterUrl = $main('ul.u-chapter.cfirst li a').first().attr('href');
        if (!latestChapterUrl) throw new Error('Could not find any chapter links');
        const latestChapterMatch = latestChapterUrl.match(/p(\d+)\.html/);
        if (!latestChapterMatch) throw new Error('Could not extract chapter number from URL');
        const latestChapter = parseInt(latestChapterMatch[1], 10);

        // Generate chapter URLs from 1 to latestChapter
        const chapterUrls = Array.from({ length: latestChapter }, (_, i) =>
            `${baseUrl}/read/${novelId}/p${latestChapter - i}.html`
        );

        console.log(`Found ${chapterUrls.length} chapters. Novel: "${novelTitle}" by ${author}`);

        // --- Prepare output directory ---
        const resultDir = path.join(__dirname, '../results');
        if (!fs.existsSync(resultDir)) {
            await mkdir(resultDir, { recursive: true });
        }

        const outputFile = path.join(resultDir, `${novelId}.json`);
        const chapters = [];

        // --- Download chapters ---
        const queue = new PQueue({ concurrency: 15 });
        let completed = 0;

        const updateProgress = () => {
            process.stdout.write(`\rDownloading: ${completed}/${chapterUrls.length} chapters`);
        };

        console.log('Starting chapter downloads...');
        updateProgress();

        await Promise.all(chapterUrls.map((url, index) =>
            queue.add(async () => {
                try {
                    const response = await axiosInstance.get(url);
                    const $ = cheerio.load(response.data);

                    // Clean unwanted elements
                    $('script, style, iframe, noscript, .abg, .ad, .ads, .hidden').remove();

                    // Extract title - preserve as-is
                    let title = $('article.page-content > h3').first().text().trim() || '';

                    // Extract paragraphs with HTML preserved
                    const paragraphs = [];
                    $('article.page-content section p').each((_, el) => {
                        const $p = $(el);
                        if ($p.hasClass('abg') || $p.closest('.ad').length || $p.closest('.ads').length) {
                            return;
                        }
                        
                        const htmlContent = $p.html();
                        if (htmlContent && htmlContent.trim().length > 0) {
                            paragraphs.push(`<p>${htmlContent.trim()}</p>`);
                        }
                    });

                    const chapterNumber = chapterUrls.length - index;
                    let content = paragraphs.join('\n');

                    if (!title && !content) {
                        return;
                    }
                    if (!content) content = "<p>Chapter is missing</p>";
                    if (!title) title = `Chapter ${chapterNumber}`;

                    chapters[chapterUrls.length - 1 - index] = {
                        title: title,
                        content: content
                    };
                } catch (error) {
                    console.error(`\nError downloading ${url}:`, error.message);
                } finally {
                    completed++;
                    updateProgress();
                }
            })
        ));

        const filteredChapters = chapters.filter(ch => ch !== undefined);
        console.log(`\n✅ Downloaded ${filteredChapters.length} chapters`);

        // ===== TRANSLATION PHASE - ALL AT ONCE AFTER DOWNLOAD =====
        if (translate) {
            console.log('\n=== STARTING TRANSLATION (ONE CHROME INSTANCE) ===');
            
            const translator = new Translator();
            await translator.init();
            
            try {
                // Translate metadata
                console.log('Translating metadata...');
                const metaTranslations = await Promise.all([
                    translator.translate(novelTitle),
                    translator.translate(author),
                    translator.translate(status),
                    translator.translate(description),
                    ...genres.map(g => translator.translate(g))
                ]);
                
                const translatedTitle = metaTranslations[0];
                const translatedAuthor = metaTranslations[1];
                const translatedStatus = metaTranslations[2];
                const translatedDescription = metaTranslations[3];
                const translatedGenres = metaTranslations.slice(4);
                
                console.log('✅ Metadata translated');
                
                // Translate chapters (with progress)
                console.log(`\nTranslating ${filteredChapters.length} chapters...`);
                for (let i = 0; i < filteredChapters.length; i++) {
                    const chapter = filteredChapters[i];
                    
                    console.log(`Chapter ${i + 1}/${filteredChapters.length}: "${chapter.title}"`);
                    
                    // Translate title
                    const translatedTitle = await translator.translate(chapter.title);
                    
                    // Translate content (preserves HTML structure)
                    const translatedContent = await translateChapterContent(chapter.content, translator);
                    
                    // REPLACE original text with English (same structure)
                    chapter.title = translatedTitle;
                    chapter.content = translatedContent;
                    
                    // Small delay to avoid rate limiting
                    if (i < filteredChapters.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
                
                console.log('✅ All chapters translated');
                
                // Update metadata with translated versions
                // (keeping same JSON structure, just replacing text)
                const finalOutput = {
                    meta: {
                        id: novelId,
                        title: translatedTitle,
                        cover: cover,
                        author: translatedAuthor,
                        authorUrl: authorUrl,
                        status: translatedStatus,
                        description: translatedDescription,
                        genres: translatedGenres,
                        totalChapters: filteredChapters.length,
                        sourceUrl: startUrl
                    },
                    chapters: filteredChapters
                };
                
                await translator.close();
                
                console.log('\n✅ Translation completed - Chrome closed');
                console.log(`✅ Output structure: Same as original, all text replaced with English`);
                
                await writeFile(outputFile, JSON.stringify(finalOutput, null, 2), 'utf8');
                console.log(`✅ Saved translated novel to ${outputFile}`);
                
                return outputFile;
                
            } catch (error) {
                await translator.close();
                throw error;
            }
        } else {
            // No translation - save original
            const finalOutput = {
                meta: {
                    id: novelId,
                    title: novelTitle,
                    cover: cover,
                    author: author,
                    authorUrl: authorUrl,
                    status: status,
                    description: description,
                    genres: genres,
                    totalChapters: filteredChapters.length,
                    sourceUrl: startUrl
                },
                chapters: filteredChapters
            };
            
            await writeFile(outputFile, JSON.stringify(finalOutput, null, 2), 'utf8');
            console.log(`✅ Saved original novel to ${outputFile}`);
            
            return outputFile;
        }
    } catch (error) {
        console.error('\n❌ Crawl failed:', error.message);
        throw error;
    }
}

// --- Run ---
const url = process.argv[2] || process.env.INPUT_URL;
const shouldTranslate = process.argv[3] === 'translate' || process.env.TRANSLATE === 'true';

if (!url) {
    console.error('Usage: node crawler.js <novel-url> [translate]');
    console.error('Example: node crawler.js https://ixdzs.tw/read/620883/ translate');
    process.exit(1);
}

crawlNovel(url, shouldTranslate)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
