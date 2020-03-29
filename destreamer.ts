import { execSync } from 'child_process';
import puppeteer from 'puppeteer';
import { terminal as term } from 'terminal-kit';
import fs from 'fs';
import path from 'path';
import { BrowserTests } from './BrowserTests';
import yargs from 'yargs'
import sanitize from 'sanitize-filename'
import axios from 'axios';


/**
 * exitCode 25 = cannot split videoID from videUrl
 * exitCode 27 = no hlsUrl in the API response
 * exitCode 29 = invalid response from API
 * exitCode 88 = error extracting cookies
 */

const ApiVersion = "1.3-private"
const args: string[] = process.argv.slice(2); // TODO: Remove this

const argv = yargs.options({
    videoUrls: { type: 'array', demandOption: true },
    username: { type: 'string', demandOption: true },
    outputDirectory: { type: 'string', default: 'videos' },
    format: {
        alias:"f",
        describe: `Expose youtube-dl --format option, for details see\n
        https://github.com/ytdl-org/youtube-dl/blob/master/README.md#format-selection`,
        type:'string',
        demandOption: false
    },
    simulate: {
        alias: "s",
        describe: `If this is set to true no video will be downloaded and the script
        will log the video info (default: false)`,
        type: "boolean",
        default: false,
        demandOption: false
    },
    verbose: {
        alias: "v",
        describe: `Print additional information to the console
        (use this before opening an issue on GitHub)`,
        type: "boolean",
        default: false,
        demandOption: false
    }
}).argv;

if (argv.simulate){
    console.info('Video URLs: %s', argv.videoUrls);
    console.info('Username: %s', argv.username);
    term.blue("There will be no video downloaded, it's only a simulation \n")
    console.log("\n")
} else {
    console.info('Video URLs: %s', argv.videoUrls);
    console.info('Username: %s', argv.username);
    console.info('Output Directory: %s', argv.outputDirectory);
    console.info('Video/Audio Quality: %s', argv.format);
    console.log("\n")
}


function sanityChecks() {
    try {
        const ytdlVer = execSync('youtube-dl --version');
        term.green(`Using youtube-dl version ${ytdlVer}`);
    }
    catch (e) {
        console.error('You need youtube-dl in $PATH for this to work. Make sure it is a relatively recent one, baked after 2019.');
        process.exit(22);
    }

    try {
        const ffmpegVer = execSync('ffmpeg -version')
            .toString().split('\n')[0];
        term.green(`Using ${ffmpegVer}\n`);
    }
    catch (e) {
        console.error('FFmpeg is missing. You need a fairly recent release of FFmpeg in $PATH.');
    }

    if (!fs.existsSync(argv.outputDirectory)){
        console.log('Creating output directory: ' +
            process.cwd() + path.sep + argv.outputDirectory);
        fs.mkdirSync(argv.outputDirectory);
    }

    /* Removed check on the first argoumenti not being null or
    longer than 10 since we use yargs now */
}

async function rentVideoForLater(videoUrls: string[], username: string, outputDirectory: string) {
    console.log('Launching headless Chrome to perform the OpenID Connect dance...');
    const browser = await puppeteer.launch({
        // Switch to false if you need to login interactively
        headless: false,
        args: ['--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    console.log('Navigating to STS login page...');

    // This breaks on slow connections, needs more reliable logic
    await page.goto(videoUrls[0], { waitUntil: "networkidle2" });
    await page.waitForSelector('input[type="email"]');
    await page.keyboard.type(username);
    await page.click('input[type="submit"]');

    await browser.waitForTarget(target => target.url().includes('microsoftstream.com/'), { timeout: 90000 });
    process.stdout.write('We are logged in. ');
    await sleep(1500);

    for (let videoUrl of videoUrls) {
        let videoID = videoUrl.split('/').pop() ?? (console.error("Couldn't split the videoID, wrong url"), process.exit(25))

        // changed waitUntil value to load (page completly loaded)
        await page.goto(videoUrl, { waitUntil: 'load' });

        await sleep(2000);
        // try this instead of hardcoding sleep
        // https://github.com/GoogleChrome/puppeteer/issues/3649

        const cookie = await exfiltrateCookie(page);
        console.log('Got cookie. Consuming cookie...');

        await sleep(4000);
        console.log("Accessing API...");

        let sessionInfo: any;
        var accesToken = await page.evaluate(
            () => {
                return sessionInfo.AccessToken;
            }
        );

        console.log("Fetching title and HLS URL...")
        var [title, hlsUrl] = await getVideoInfo(videoID, accesToken)

        title = (sanitize(title) == "") ? `Video${videoUrls.indexOf(videoUrl)}` : sanitize(title)

        term.blue("Video title is: ")
        console.log(`${title} \n`)

        console.log('Spawning youtube-dl with cookie and HLS URL...');

        const format = argv.format ? `-f "${argv.format}"` : ""

        var youtubedlCmd = 'youtube-dl --no-call-home --no-warnings ' + format +
                ` --output "${outputDirectory}/${title}.mp4" --add-header ` +
                `Cookie:"${cookie}" "${hlsUrl}"`

        if (argv.simulate)
            youtubedlCmd = youtubedlCmd + " -s"

        // console.log(`\n\n[DEBUG] Invoking youtube-dl: ${youtubedlCmd}\n\n`);
        var result = execSync(youtubedlCmd, { stdio: 'inherit' });
    }

    console.log("At this point Chrome's job is done, shutting it down...");
    await browser.close();
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function exfiltrateCookie(page: puppeteer.Page) {
    var jar = await page.cookies("https://.api.microsoftstream.com");
    var authzCookie = jar.filter(c => c.name === 'Authorization_Api')[0];
    var sigCookie = jar.filter(c => c.name === 'Signature_Api')[0];

    if (authzCookie == null || sigCookie == null) {
        await sleep(5000);
        var jar = await page.cookies("https://.api.microsoftstream.com");
        var authzCookie = jar.filter(c => c.name === 'Authorization_Api')[0];
        var sigCookie = jar.filter(c => c.name === 'Signature_Api')[0];
    }

    if (authzCookie == null || sigCookie == null) {
        console.error('Unable to read cookies. Try launching one more time, this is not an exact science.');
        process.exit(88);
    }

    return `Authorization=${authzCookie.value}; Signature=${sigCookie.value}`;
}


async function getVideoInfo(videoID: string, accesToken: string) {
    let title: string;
    let hlsUrl: string;

    let content = axios.get(
        `https://api.microsoftstream.com/api/videos/${videoID}` +
        `?$expand=creator,tokens,status,liveEvent,extensions&api-version=${ApiVersion}`,
        {
            headers: {
                Authorization: `Bearer ${accesToken}`
            }
        })
        .then(function (response) {
            return response.data;
        })
        .catch(function (error) {
            term.red("Error when calling Microsoft Stream API:")
            console.error(error.response.status);
            console.error(error.response.data);
            console.error("Exiting...");
            if (argv.verbose)
                console.error(error)

            process.exit(29)
        })


        title = await content.then(data => {
            return data["name"];
        })

        hlsUrl = await content.then(data => {
            if (argv.verbose)
                console.log(JSON.stringify(data, undefined, 2))

            for (const item of data["playbackUrls"]) {
                if (item["mimeType"] == "application/vnd.apple.mpegurl")
                    return item["playbackUrl"]
            }
            console.error("Error fetching hlsUrl")
            process.exit(27)
        })

    return [title, hlsUrl];
}

// We should probably use Mocha or something
if (args[0] === 'test')
{
    BrowserTests();
}

else {
    sanityChecks();
    rentVideoForLater(argv.videoUrls as string[], argv.username, argv.outputDirectory);
}
