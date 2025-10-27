const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { promisify } = require('util');
const { default: PQueue } = require('p-queue');

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

async function crawlNovel(startUrl) {
    try {
        console.log(`Starting crawl for URL: ${startUrl}`);

        if (!startUrl.startsWith('http')) {
            startUrl = `https://${startUrl}`;
        }

        const novelIdMatch = startUrl.match(/\/read\/(\d+)/);
        if (!novelIdMatch) throw new Error('Invalid URL format');
        const novelId = novelIdMatch[1];

        const baseUrl = new URL(startUrl).origin;
        const axiosInstance = axios.create({
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });

        // === STEP 1: Fetch main novel page to extract metadata ===
        const mainNovelPageUrl = `${baseUrl}/book/${novelId}/`; // Adjust if needed based on site structure
        const mainPageRes = await axiosInstance.get(mainNovelPageUrl);
        const $main = cheerio.load(mainPageRes.data);

        // Extract metadata
        const novelTitle = $main('.n-text h1').first().text().trim() || 'Untitled';
        const cover = $main('.n-img img').attr('src') || '';
        const author = $main('.n-text p a.bauthor').first().text().trim() || 'Unknown';
        const authorUrlEl = $main('.n-text p a.bauthor').first().attr('href');
        const authorUrl = authorUrlEl ? new URL(authorUrlEl, mainNovelPageUrl).href : null;

        let status = 'Unknown';
        const lzText = $main('.n-text p .lz').text().trim();
        const endText = $main('.n-text p .end').text().trim();
        if (lzText) status = lzText;
        else if (endText) status = endText;

        const description = $main('#intro').text().trim() || '';

        const genres = [];
        $main('.tags em a').each((_, el) => {
            const genre = $main(el).text().trim();
            if (genre) genres.push(genre);
        });

        // === STEP 2: Get latest chapter number from chapter list ===
        const chapterListPageUrl = startUrl; // assuming startUrl is the chapter list
        const chapterListRes = await axiosInstance.get(chapterListPageUrl);
        const $chapters = cheerio.load(chapterListRes.data);
        const lastLink = $chapters('.u-chapter.cfirst li a').last(); // last <a> in list
        if (!lastLink.length) throw new Error("Couldn't find last chapter link");

        const href = lastLink.attr('href');
        const match = href.match(/p(\d+)\.html$/);
        if (!match) throw new Error("Couldn't extract last chapter number");
        const latestChapter = parseInt(match[1], 10);

        // === STEP 3: Generate chapter URLs ===
        const chapterUrls = Array.from({ length: latestChapter }, (_, i) =>
            `${baseUrl}/read/${novelId}/p${latestChapter - i}.html`
        );

        console.log(`Found ${chapterUrls.length} chapters to download`);

        // === STEP 4: Prepare output directory ===
        const resultDir = path.join(__dirname, '../results');
        if (!fs.existsSync(resultDir)) {
            await mkdir(resultDir, { recursive: true });
        }

        const outputFile = path.join(resultDir, `${novelId}.json`);
        const chapters = [];

        // === STEP 5: Download chapters in parallel ===
        const queue = new PQueue({ concurrency: 25 });
        let completed = 0;

        const updateProgress = () => {
            process.stdout.write(`\rDownloading: ${completed}/${chapterUrls.length} chapters`);
        };

        console.log('Starting downloads...');
        updateProgress();

        await Promise.all(chapterUrls.map((url, index) =>
            queue.add(async () => {
                try {
                    const response = await axiosInstance.get(url);
                    const $ = cheerio.load(response.data);

                    $('script, style, iframe, noscript, p.abg, .ad, .ads').remove();

                    let title = $('article.page-content > h3').text().trim();
                    let content = $('article.page-content section p')
                        .map((_, el) => $(el).text().trim().replace(/https?:\/\/[^\s]+/g, ''))
                        .get()
                        .join('\n\n');

                    const chapterNumber = chapterUrls.length - index;

                    if (!title && !content) {
                        return; // skip
                    } else if (!content) {
                        content = "Chapter is missing";
                    } else if (!title) {
                        title = "Empty";
                    }

                    chapters[chapterUrls.length - 1 - index] = {
                        title: title || `Chapter ${chapterNumber}`,
                        content
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

        // === STEP 6: Assemble final output with metadata ===
        const finalOutput = {
            metadata: {
                id: novelId,
                title: novelTitle,
                cover,
                author,
                authorUrl,
                status,
                description,
                genres,
                totalChapters: filteredChapters.length,
                sourceUrl: mainNovelPageUrl
            },
            chapters: filteredChapters
        };

        console.log('\n');
        await writeFile(outputFile, JSON.stringify(finalOutput, null, 2));
        console.log(`Saved ${filteredChapters.length} chapters + metadata to ${outputFile}`);

        return outputFile;
    } catch (error) {
        console.error('\nCrawl failed:', error.message);
        throw error;
    }
}

// Run
const url = process.argv[2] || process.env.INPUT_URL;
if (!url) {
    console.error('Please provide a URL');
    process.exit(1);
}

crawlNovel(url)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
