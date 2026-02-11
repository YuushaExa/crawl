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
const readFile = promisify(fs.readFile);

// ===== TRANSLATION CACHE (PERSISTENT) =====
class TranslationCache {
    constructor(cacheFile) {
        this.cacheFile = cacheFile;
        this.cache = new Map();
        this.dirty = false;
    }

    async load() {
        try {
            if (fs.existsSync(this.cacheFile)) {
                const data = await readFile(this.cacheFile, 'utf8');
                const parsed = JSON.parse(data);
                Object.entries(parsed).forEach(([k, v]) => this.cache.set(k, v));
                console.log(`✅ Loaded ${this.cache.size} cached translations`);
            }
        } catch (e) {
            console.warn('⚠️ Cache load failed, starting fresh');
        }
    }

    get(text) {
        return this.cache.get(text.trim().toLowerCase()) || null;
    }

    set(text, translation) {
        const key = text.trim().toLowerCase();
        if (!this.cache.has(key)) {
            this.cache.set(key, translation);
            this.dirty = true;
        }
    }

    async save() {
        if (!this.dirty) return;
        try {
            await writeFile(this.cacheFile, JSON.stringify(Object.fromEntries(this.cache)), 'utf8');
            this.dirty = false;
            console.log(`💾 Saved ${this.cache.size} translations to cache`);
        } catch (e) {
            console.warn('⚠️ Cache save failed');
        }
    }
}

// ===== SINGLE BROWSER TRANSLATION MANAGER (OPTIMIZED) =====
class Translator {
    constructor(cache) {
        this.browser = null;
        this.page = null;
        this.cache = cache;
        this.selectorConfig = {
            textarea: [
                'textarea[aria-label="Source text"]',
                'textarea[aria-label="原文"]', // Fallback for zh-CN UI
                '.er8xn'
            ],
            result: [
                'span[class*="ryNqvb"]',
                'span[class*="translation"]',
                '.lRu31'
            ]
        };
    }

    async init() {
        console.log('🚀 Launching optimized Chrome instance...');
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
                '--no-default-browser-check',
                '--window-size=1280,800'
            ]
        });

        this.page = await this.browser.newPage();
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        
        // Navigate to Google Translate with optimized params
        await this.page.goto('https://translate.google.com/?sl=zh-CN&tl=en&op=translate', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        
        // Wait for critical elements with fallbacks
        await this._waitForSelectorAny(this.selectorConfig.textarea, 15000);
        console.log('✅ Translation engine ready (optimized)');
    }

    // Smart wait for ANY matching selector
    async _waitForSelectorAny(selectors, timeout = 10000) {
        const checks = selectors.map(sel => 
            this.page.waitForSelector(sel, { timeout: 100 }).catch(() => null)
        );
        for (const check of checks) {
            try {
                await Promise.race([check, new Promise(r => setTimeout(r, 50))]);
                return true;
            } catch {}
        }
        throw new Error(`Selectors not found: ${selectors.join(', ')}`);
    }

    // Get first matching selector that exists
    _getExistingSelector(selectors) {
        return this.page.evaluate((sels) => {
            for (const sel of sels) {
                if (document.querySelector(sel)) return sel;
            }
            return null;
        }, selectors);
    }

    async translate(text) {
        const cleanText = text.trim();
        if (!cleanText || cleanText.length < 2) return text;

        // CACHE CHECK (critical speed boost)
        const cached = this.cache.get(cleanText);
        if (cached) return cached;

        try {
            // Get active selectors (handles UI changes)
            const textareaSel = await this._getExistingSelector(this.selectorConfig.textarea);
            const resultSel = await this._getExistingSelector(this.selectorConfig.result);
            
            if (!textareaSel || !resultSel) {
                throw new Error('Translation UI selectors invalid - Google updated?');
            }

            // ⚡ INSTANT TEXT INJECTION (no typing delay!)
            await this.page.evaluate((sel, val) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.value = val;
                    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, textareaSel, cleanText);

            // ⏱ SMART WAIT: Poll for non-empty result (no fixed timeouts)
            await this.page.waitForFunction(
                (sel) => {
                    const els = document.querySelectorAll(sel);
                    return Array.from(els).some(el => 
                        el.textContent?.trim().length > 0 && 
                        !['...', '⋯', 'Translating'].includes(el.textContent.trim())
                    );
                },
                { timeout: 12000, polling: 150 },
                resultSel
            );

            // Extract clean translation
            const translated = await this.page.evaluate((sel) => {
                return Array.from(document.querySelectorAll(sel))
                    .map(el => el.textContent.trim())
                    .filter(t => t && !/^\.{3,}$/.test(t))
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim();
            }, resultSel);

            // Cache successful translation
            if (translated && translated !== cleanText) {
                this.cache.set(cleanText, translated);
                return translated;
            }
            
            console.warn(`⚠️ Translation suspicious (fallback): "${cleanText.substring(0, 30)}..."`);
            return cleanText;
            
        } catch (error) {
            console.error(`<translation-error text="${cleanText.substring(0, 40)}...">`, error.message);
            // Fallback: return original with cache to avoid retrying failures
            this.cache.set(cleanText, cleanText);
            return cleanText;
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            console.log('✅ Translation browser closed');
        }
    }
}

// ===== HTML-AWARE TRANSLATION (PRESERVES ALL TAGS) =====
async function translateChapterContent(htmlContent, translator) {
    if (!htmlContent?.trim()) return htmlContent;
    
    // Parse HTML while preserving structure
    const $ = cheerio.load(`<div>${htmlContent}</div>`, { 
        decodeEntities: false,
        xmlMode: false 
    });
    
    // Collect ALL translatable text nodes (preserves HTML structure)
    const textNodes = [];
    const walker = (node) => {
        if (node.type === 'text' && node.data?.trim()) {
            textNodes.push({ 
                node, 
                original: node.data.trim(),
                parent: node.parent
            });
        }
        if (node.children) {
            node.children.forEach(walker);
        }
    };
    
    $('div').contents().each((_, el) => {
        walker(el);
    });

    if (textNodes.length === 0) return htmlContent;

    // Translate with progress + caching
    console.log(`   📝 Translating ${textNodes.length} text segments...`);
    for (let i = 0; i < textNodes.length; i++) {
        const segment = textNodes[i];
        segment.translated = await translator.translate(segment.original);
        
        // Update node content directly (preserves all tags!)
        segment.node.data = segment.translated;
        
        // Optional: Show progress for long chapters
        if (textNodes.length > 20 && (i + 1) % 10 === 0) {
            console.log(`   ➤ ${i + 1}/${textNodes.length} segments translated`);
        }
    }

    return $('div').html();
}

// ===== SMART RETRY UTILITY =====
async function withRetry(fn, retries = 3, delayMs = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            const wait = delayMs * Math.pow(2, i);
            console.warn(`⚠️ Retry ${i + 1}/${retries} after ${wait}ms: ${error.message}`);
            await new Promise(res => setTimeout(res, wait));
        }
    }
}

// ===== MAIN CRAWL FUNCTION (OPTIMIZED) =====
async function crawlNovel(startUrl, translate = true) {
    const startTime = Date.now();
    const cacheFile = path.join(__dirname, '.translation_cache.json');
    const translationCache = new TranslationCache(cacheFile);
    
    try {
        // Load translation cache early
        if (translate) await translationCache.load();

        console.log(`\n🌐 Starting crawl: ${startUrl}`);
        console.log(`🔤 Translation: ${translate ? 'ENABLED (with caching)' : 'DISABLED'}`);

        // Normalize URL
        if (!startUrl.startsWith('http')) startUrl = `https://${startUrl}`;
        const novelIdMatch = startUrl.match(/\/read\/(\d+)/);
        if (!novelIdMatch) throw new Error('Invalid URL: must contain /read/{id}');
        const novelId = novelIdMatch[1];
        const baseUrl = new URL(startUrl).origin;

        // Configure axios
        const axiosInstance = axios.create({
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Connection': 'keep-alive'
            }
        });

        // === FETCH METADATA ===
        console.log('📡 Fetching novel metadata...');
        const mainPageResponse = await withRetry(() => axiosInstance.get(startUrl));
        const $main = cheerio.load(mainPageResponse.data);

        // Extract metadata (with fallbacks)
        const novelTitle = $main('.n-text h1').first().text().trim() || 'Untitled';
        const cover = $main('.n-img img').attr('src')?.trim() || '';
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

        // Get chapter count
        const latestChapterUrl = $main('ul.u-chapter.cfirst li a').first().attr('href');
        if (!latestChapterUrl) throw new Error('No chapter links found');
        const latestChapterMatch = latestChapterUrl.match(/p(\d+)\.html/);
        if (!latestChapterMatch) throw new Error('Invalid chapter URL format');
        const latestChapter = parseInt(latestChapterMatch[1], 10);
        const chapterUrls = Array.from({ length: latestChapter }, (_, i) =>
            `${baseUrl}/read/${novelId}/p${latestChapter - i}.html`
        );

        console.log(`📚 Novel: "${novelTitle}" by ${author} | ${chapterUrls.length} chapters`);

        // === SETUP OUTPUT ===
        const resultDir = path.join(__dirname, '../results');
        await mkdir(resultDir, { recursive: true });
        const outputFile = path.join(resultDir, `${novelId}.json`);
        const chapters = [];

        // === DOWNLOAD CHAPTERS (CONCURRENT) ===
        console.log(`\n📥 Downloading ${chapterUrls.length} chapters (concurrency: 15)...`);
        const queue = new PQueue({ concurrency: 15 });
        let completed = 0;
        const updateProgress = () => {
            const pct = ((completed / chapterUrls.length) * 100).toFixed(1);
            process.stdout.write(`\r📥 Progress: ${completed}/${chapterUrls.length} (${pct}%)`);
        };

        await Promise.all(chapterUrls.map((url, index) =>
            queue.add(async () => {
                try {
                    const response = await withRetry(() => axiosInstance.get(url));
                    const $ = cheerio.load(response.data);
                    
                    // Clean ads/unwanted elements
                    $('script, style, iframe, noscript, .abg, .ad, .ads, .hidden, [class*="ad-"]').remove();
                    
                    // Extract title
                    let title = $('article.page-content > h3').first().text().trim() || `Chapter ${chapterUrls.length - index}`;
                    
                    // Extract content paragraphs (preserving HTML)
                    const paragraphs = [];
                    $('article.page-content section p').each((_, el) => {
                        const $p = $(el);
                        // Skip ad containers
                        if ($p.hasClass('abg') || $p.parents('.ad, .ads').length) return;
                        
                        const html = $p.html()?.trim();
                        if (html && html.length > 5) paragraphs.push(`<p>${html}</p>`);
                    });
                    
                    const content = paragraphs.join('\n') || '<p>Content unavailable</p>';
                    const chapterNumber = chapterUrls.length - index;
                    
                    chapters[chapterNumber - 1] = { title, content, number: chapterNumber };
                } catch (error) {
                    console.error(`\n❌ Download failed ${url}: ${error.message}`);
                } finally {
                    completed++;
                    updateProgress();
                }
            }, { throwOnTimeout: true })
        ));
        
        console.log(`\n✅ Downloaded ${chapters.filter(c => c).length}/${chapterUrls.length} chapters`);

        // === TRANSLATION PHASE (OPTIMIZED) ===
        if (translate) {
            console.log(`\n🌍 STARTING TRANSLATION (Cached: ${translationCache.cache.size} entries)`);
            const translator = new Translator(translationCache);
            await translator.init();
            
            try {
                // Translate metadata SEQUENTIALLY (avoids page collisions)
                console.log('🔤 Translating metadata...');
                const meta = {
                    title: await translator.translate(novelTitle),
                    author: await translator.translate(author),
                    status: await translator.translate(status),
                    description: await translator.translate(description),
                    genres: []
                };
                
                // Translate genres sequentially
                for (const genre of genres) {
                    meta.genres.push(await translator.translate(genre));
                }
                console.log('✅ Metadata translated');

                // Translate chapters with progress + ETA
                console.log(`\n챕터 Translating ${chapters.length} chapters...`);
                const chapterStart = Date.now();
                for (let i = 0; i < chapters.length; i++) {
                    if (!chapters[i]) continue;
                    
                    const chapter = chapters[i];
                    const chapterNum = i + 1;
                    const elapsedSec = Math.floor((Date.now() - chapterStart) / 1000);
                    const etaSec = chapters.length > 1 ? Math.floor(elapsedSec / chapterNum * (chapters.length - chapterNum)) : 0;
                    
                    console.log(`챕터 [${chapterNum}/${chapters.length}] ETA: ${etaSec}s | "${chapter.title.substring(0, 40)}..."`);
                    
                    // Translate title
                    chapter.title = await translator.translate(chapter.title);
                    
                    // Translate content WITH HTML PRESERVATION
                    chapter.content = await translateChapterContent(chapter.content, translator);
                    
                    // Smart delay: only if needed (reduces to 300ms)
                    if (chapterNum < chapters.length) {
                        await new Promise(res => setTimeout(res, 300));
                    }
                }
                
                console.log('✅ All chapters translated');
                await translator.close();
                
                // Save cache BEFORE writing output (critical!)
                await translationCache.save();
                
                // Build final output
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
                        sourceUrl: startUrl,
                        translatedAt: new Date().toISOString()
                    },
                    chapters: chapters.filter(c => c)
                };
                
                await writeFile(outputFile, JSON.stringify(finalOutput, null, 2), 'utf8');
                console.log(`\n✅ Saved translated novel to: ${outputFile}`);
                
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
            console.log(`\n✅ Saved original novel to: ${outputFile}`);
        }

        // Final stats
        const duration = Math.floor((Date.now() - startTime) / 1000);
        console.log(`\n🎉 COMPLETE! Total time: ${duration}s | Avg: ${(duration / chapters.length).toFixed(1)}s/chapter`);
        return outputFile;
        
    } catch (error) {
        console.error(`\n💥 FATAL ERROR: ${error.message}`);
        console.error(error.stack);
        throw error;
    } finally {
        // Always save cache on exit
        if (translate) await translationCache.save();
    }
}

// ===== EXECUTION HANDLER =====
(async () => {
    const url = process.argv[2] || process.env.INPUT_URL;
    const shouldTranslate = process.argv[3] === 'translate' || process.env.TRANSLATE === 'true';

    if (!url) {
        console.error('❌ Usage: node crawler.js <novel-url> [translate]');
        console.error('   Example: node crawler.js https://ixdzs.tw/read/620883/ translate');
        process.exit(1);
    }

    try {
        const output = await crawlNovel(url, shouldTranslate);
        console.log(`\n✨ Output: ${output}`);
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Process failed. Check logs above.');
        process.exit(1);
    }
})();
