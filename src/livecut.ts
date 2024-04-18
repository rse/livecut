/*
**  LiveCut - Live Cutting of Video Replay Snippets
**  Copyright (c) 2024 Dr. Ralf S. Engelschall <rse@engelschall.com>
**  Licensed under GPL 3.0 <https://spdx.org/licenses/GPL-3.0-only>
*/

/*  import built-in dependencies  */
import path           from "node:path"
import http           from "node:http"
import fs             from "node:fs"

/*  import external dependencies  */
import { sprintf }    from "sprintf-js"
import CLIio          from "cli-io"
import yargs          from "yargs"
import execa          from "execa"
import chokidar       from "chokidar"
import * as HAPI      from "@hapi/hapi"
import Boom           from "@hapi/boom"
import { Server }     from "@hapi/hapi"
import HAPIWebSocket  from "hapi-plugin-websocket"
import WebSocket      from "ws"
import ffmpegConcat   from "ffmpeg-concat"
import ffmpeg         from "fluent-ffmpeg"

/*  import own dependencies  */
import pkg            from "../package.json"

/*  keep CLI environment in outmost context  */
let cli: CLIio | null = null

/*  establish asynchronous environment  */
;(async () => {
    /*  dynamically import external dependencies (workaround)  */
    const { type } = await import("arktype")

    /*  parse command-line arguments  */
    const args = await yargs()
        /* eslint indent: off */
        .usage(
            "Usage: $0 " +
            "[-h|--help] " +
            "[-V|--version] " +
            "[-v|--verbose <level>] " +
            "[-i|--input <directory>] " +
            "[-I|--input-regex <regex>] " +
            "[-q|--queue <directory>] " +
            "[-Q|--queue-slots <number>] " +
            "[-o|--output <file>] " +
            "[-c|--losslesscut <program>] " +
            "[-t|--transition <transition-id>] " +
            "[-a|--http-addr <ip-address>] " +
            "[-p|--http-port <tcp-port>]")
        .help("h").alias("h", "help").default("h", false)
            .describe("h", "show usage help")
        .boolean("V").alias("V", "version").default("V", false)
            .describe("V", "show program version information")
        .string("v").nargs("v", 1).alias("v", "log-level").default("v", "warning")
            .describe("v", "level for verbose logging ('none', 'error', 'warning', 'info', 'debug')")
        .string("i").nargs("i", 1).alias("i", "input").default("i", ".")
            .describe("i", "directory of input files")
        .string("I").nargs("I", 1).alias("I", "input-regex").default("I", "replay.+mp4")
            .describe("I", "regular expression to match input files")
        .string("q").nargs("q", 1).alias("q", "queue").default("q", ".")
            .describe("q", "directory of queue files")
        .number("Q").nargs("Q", 1).alias("Q", "queue-slots").default("Q", 9)
            .describe("Q", "number of queue slots")
        .string("o").nargs("o", 1).alias("o", "output").default("o", "replay.mp4")
            .describe("o", "filename of output file")
        .string("c").nargs("c", 1).alias("c", "losslesscut").default("c", "C:\\Program Files\\LosslessCut\\LosslessCut.exe")
            .describe("c", "path to LosslessCut.exe")
        .string("t").nargs("t", 1).alias("t", "transition").default("t", "PERL")
            .describe("t", "name of GL transition to use for exporting")
        .string("a").nargs("a", 1).alias("a", "http-addr").default("a", "127.0.0.1")
            .describe("a", "HTTP/Websocket listen IP address")
        .number("p").nargs("p", 1).alias("p", "http-port").default("p", 12345)
            .describe("p", "HTTP/Websocket listen TCP port")
        .version(false)
        .strict()
        .showHelpOnFail(true)
        .demand(0)
        .parse(process.argv.slice(2))

    /*  short-circuit version request  */
    if (args.version) {
        process.stderr.write(`${pkg.name} ${pkg.version} <${pkg.homepage}>\n`)
        process.stderr.write(`${pkg.description}\n`)
        process.stderr.write(`Copyright (c) 2024 ${pkg.author.name} <${pkg.author.url}>\n`)
        process.stderr.write(`Licensed under ${pkg.license} <http://spdx.org/licenses/${pkg.license}.html>\n`)
        process.exit(0)
    }

    /*  initialize CLI environment  */
    cli = new CLIio({
        encoding:  "utf8",
        logLevel:  args.logLevel,
        logTime:   true,
        logPrefix: pkg.name
    })
    cli!.log("info", `main: starting LiveCut service ${pkg.version}`)

    /*  establish WebSocket state  */
    type wsPeerCtx = { id: string }
    type wsPeerInfo = { ctx: wsPeerCtx, ws: WebSocket, req: http.IncomingMessage }
    const wsPeers = new Map<string, wsPeerInfo>()

    /*  establish replay slot state  */
    enum SlotStates { CLEAR = 0, UNCUTTED = 1, CUTTED = 2 }
    let progress = false
    const transitions: { [ name: string ]: { name: string, time: number, params?: any } } = {
        /*  see https://gl-transitions.com/gallery  */
        "CUTX": { name: "fade",            time: 33  }, /* special case: emulation of a CUT transition */
        "PERL": { name: "perlin",          time: 300, params: { scale: 4.0, smoothness: 0.01, seed: 12.9898 } },
        "FADE": { name: "fade",            time: 300 },
        "ZOOM": { name: "crosszoom",       time: 300 },
        "MRPH": { name: "morph",           time: 300 },
        "DREA": { name: "dreamy",          time: 300 },
        "RIPP": { name: "ripple",          time: 300 },
        "WARP": { name: "directionalwarp", time: 300, params: { direction: [ 1, 0 ] } },
        "WIPE": { name: "wipeleft",        time: 300 },
        "RADI": { name: "radial",          time: 300 },
        "CUBE": { name: "cube",            time: 400 },
        "SWAP": { name: "swap",            time: 400 }
    }
    let transition: keyof typeof transitions = args.transition! as keyof typeof transitions
    if (!transition)
        throw new Error(`invalid initial export transition ${args.transition}`)
    const slotState = [] as SlotStates[]
    for (let i = 0; i < args.queueSlots!; i++)
        slotState[i] = SlotStates.CLEAR

    /*  notify clients about new replay slot state  */
    const notifyState = () => {
        const msg = JSON.stringify({ slots: slotState, progress, transition })
        for (const id of wsPeers.keys()) {
            const info = wsPeers.get(id)!
            cli!.log("info", `WebSocket: notify: remote=${id}`)
            if (info.ws.readyState === WebSocket.OPEN)
                info.ws.send(msg)
        }
    }

    /*  utility function: determine filename of replay slot  */
    const slotName = (slot: number, type: "orig" | "cutted" | "faded" | "overlayed" | "proj" = "orig") => {
        let tag = ""
        let ext = "mp4"
        if (type === "cutted")
            tag = "-cutted"
        else if (type === "faded")
            tag = "-faded"
        else if (type === "overlayed")
            tag = "-overlayed"
        else if (type === "proj") {
            tag = "-proj"
            ext = "llc"
        }
        return path.join(args.queue!, sprintf("replay-%02d%s.%s", slot, tag, ext))
    }

    /*  utility function: determine creation time of replay slot  */
    const slotCreationTime = async (slot: number, type: "orig" | "cutted" | "faded" | "overlayed" | "proj" = "orig") =>
        await fs.promises.stat(slotName(slot, type))
            .then((stat) => stat.ctime).catch(() => new Date())

    /*  utility function: determine whether replay slot is used  */
    const slotUsed = async (slot: number, type: "orig" | "cutted" | "faded" | "overlayed" | "proj" = "orig") =>
        await fs.promises.stat(slotName(slot, type))
            .then(() => true).catch(() => false)

    /*  utility function: move content between replay slots  */
    const slotMove = async (slotSrc: number, slotDst: number) => {
        cli?.log("info", `replay slots: moving content from slot #${slotSrc} to #${slotDst}`)
        await fs.promises.rename(slotName(slotSrc), slotName(slotDst))
        if (await slotUsed(slotSrc, "cutted"))
            await fs.promises.rename(slotName(slotSrc, "cutted"), slotName(slotDst, "cutted"))
        if (await slotUsed(slotSrc, "faded"))
            await fs.promises.rename(slotName(slotSrc, "faded"), slotName(slotDst, "faded"))
        if (await slotUsed(slotSrc, "overlayed"))
            await fs.promises.rename(slotName(slotSrc, "overlayed"), slotName(slotDst, "overlayed"))
        if (await slotUsed(slotSrc, "proj"))
            await fs.promises.rename(slotName(slotSrc, "proj"), slotName(slotDst, "proj"))
        slotState[slotDst - 1] = slotState[slotSrc - 1]
        slotState[slotSrc - 1] = SlotStates.CLEAR
        notifyState()
    }

    /*  utility function: clear content in replay slot  */
    const slotClear = async (slot: number) => {
        cli?.log("info", `replay slots: removing content in slot #${slot}`)
        if (await slotUsed(slot))
            await fs.promises.unlink(slotName(slot))
        if (await slotUsed(slot, "cutted"))
            await fs.promises.unlink(slotName(slot, "cutted"))
        if (await slotUsed(slot, "faded"))
            await fs.promises.unlink(slotName(slot, "faded"))
        if (await slotUsed(slot, "overlayed"))
            await fs.promises.unlink(slotName(slot, "overlayed"))
        if (await slotUsed(slot, "proj"))
            await fs.promises.unlink(slotName(slot, "proj"))
        slotState[slot - 1] = SlotStates.CLEAR
        notifyState()
    }

    /*  utility function: determine next free replay slot  */
    const slotFree = async () => {
        let slot = 1
        while (slot <= args.queueSlots!) {
            if (!(await slotUsed(slot)))
                break
            slot++
        }
        if (slot > args.queueSlots!)
            return 0
        return slot
    }

    /*  utility function: compress the content into continuous list of replay slots  */
    const slotCompress = async () => {
        let slot = 1
        while (slot <= args.queueSlots!) {
            if (!(await slotUsed(slot))) {
                /*  find next unused slot  */
                let j = slot
                while (j <= args.queueSlots!) {
                    if (await slotUsed(j))
                        break
                    j++
                }
                if (j > args.queueSlots!)
                    break

                /*  move next remaining used slots  */
                await slotMove(j, slot++)
                continue
            }
            slot++
        }
    }

    /*  utility function: update replay slot states from disk  */
    const slotUpdateState = async () => {
        let slot = 1
        while (slot <= args.queueSlots!) {
            const existsCutted   = await fs.promises.stat(slotName(slot, "cutted")).then(() => true).catch(() => false)
            const existsOriginal = await fs.promises.stat(slotName(slot, "orig")).then(() => true).catch(() => false)
            if      (existsCutted && existsOriginal) slotState[slot - 1] = SlotStates.CUTTED
            else if (existsOriginal)                 slotState[slot - 1] = SlotStates.UNCUTTED
            else                                     slotState[slot - 1] = SlotStates.CLEAR
            slot++
        }
        cli?.log("info", "replay slots: updated internal state")
        notifyState()
    }

    /*  initially once update replay slot states from disk  */
    await slotUpdateState()

    /*  determine our custom Lossless Cut settings  */
    const losslessCutSettings = await fs.promises.readFile(path.join(__dirname, "losslesscut.json"), "utf8")

    /*  command function: edit a replay slot  */
    const cmdEdit = async (slot: number) => {
        cli?.log("info", `command: EDIT: edit replay slot #${slot}`)
        if (!(await slotUsed(slot))) {
            cli!.log("error", `command: EDIT: cannot edit slot #${slot}: still not used`)
            return
        }
        const filename = slotName(slot)
        progress = true
        notifyState()
        await execa(args.losslesscut!, [ "--settings-json", losslessCutSettings, filename ], {
            stdio:       "ignore",
            detached:    true,
            windowsHide: false
        }).catch((err: Error) => {
            cli!.log("error", `command: EDIT: LosslessCut: ${err}`)
            return true
        })
        progress = false
        notifyState()
        await slotUpdateState()
    }

    /*  command function: clear a replay slot  */
    const cmdClear = async (slot: number) => {
        cli?.log("info", `command: CLEAR: remove slot #${slot}`)
        if (!(await slotUsed(slot))) {
            cli!.log("error", `command: CLEAR: cannot clear slot #${slot}: still not used (already clear)`)
            return
        }
        await slotClear(slot)
        await slotCompress()
    }

    /*  command function: transition change  */
    const cmdTransition = async () => {
        const T = Object.keys(transitions) as Array<keyof typeof transitions>
        const i = (T.findIndex((t) => t === transition) + 1) % T.length
        cli?.log("info", `command: TRANSITION: cycle transitions from ${transition} to ${T[i]}`)
        transition = T[i]
        notifyState()
    }

    /*  command function: export all replay slots  */
    const cmdExport = async () => {
        /*  ensure we are in sane situation (should be not really necessary)  */
        await slotCompress()
        await slotUpdateState()

        /*  determine cutted replays  */
        const replays = []
        for (let i = 0; i < args.queueSlots!; i++)
            if (await slotUsed(i, "cutted"))
                replays.push(i)
        if (replays.length === 0) {
            cli!.log("error", "command: EXPORT: no cutted replays available")
            return
        }

        /*  indicate start of processing  */
        cli?.log("info", "EXPORT: FFmpeg process: start")
        progress = true
        notifyState()

        /*  fade in/out audio tracks for smoother transition  */
        cli?.log("info", "command: EXPORT: audio-faded replay videos")
        for (const i of replays) {
            const duration = await new Promise<number>((resolve, reject) => {
                ffmpeg.ffprobe(slotName(i, "cutted"), (err: Error, data: any) => {
                    if (err)
                        reject(err)
                    if (typeof data?.format?.duration !== "number")
                        reject(new Error("invalid response"))
                    resolve(data.format.duration)
                })
            })
            const fade = 0.20
            await new Promise((resolve, reject) => {
                ffmpeg(slotName(i, "cutted"))
                    .output(slotName(i, "faded"))
                    .videoCodec("copy")
                    .audioFilter(`afade=t=in:st=0:d=${fade}`)
                    .audioFilter(`afade=t=out:st=${duration - fade}:d=${fade}`)
                    .on("start", (cmd: any) => { cli?.log("info", `execute: ${cmd}`) })
                    .on("stderr", (output: string) => { cli?.log("debug", `ffmpeg: ${output}`) })
                    .on("error", (err: Error) => { reject(err) })
                    .on("end", () => { resolve(true) })
                    .run()
            })
        }

        /*  overlay video tracks for replay visual appearance  */
        cli?.log("info", "command: EXPORT: video-overlayed replay videos")
        const pngFile = path.join(__dirname, "replay-overlay.png")
        const ttfFile = path.join(__dirname, "replay-overlay.ttf").replace(/\\/g, "\\\\").replace(/:/g, "\\:")
        const cfgFile = path.resolve(path.join(__dirname, "fonts.conf"))
        process.env.FONTCONFIG_FILE = cfgFile
        for (const i of replays) {
            const ctime = await slotCreationTime(i, "orig")
            const timeOffset = ctime.getHours() * (60 * 60) + ctime.getMinutes() * 60 + ctime.getSeconds()
            await new Promise((resolve, reject) => {
                ffmpeg(slotName(i, "faded"))
                    .input(pngFile)
                    .complexFilter(
                        "[0:v][1:v] " +
                            "overlay=W-w:H-h " +
                        "[v]; " +
                        "[v] " +
                            `drawtext= font='TypoPRO Source Sans Pro': fontfile='${ttfFile}': fontsize=50: fontcolor=red: ` +
                            "x=((w-text_w)-40): y=((h-text_h)-50): " +
                            `text='%{pts\\:gmtime\\:${timeOffset}\\:%H\\\\\\:%M\\\\\\:%S}' ` +
                        "[v]",
                        [ "[v]" ])
                    .audioCodec("copy")
                    .addOption([ "-map 0:a" ])
                    .output(slotName(i, "overlayed"))
                    .on("start", (cmd: any) => { cli?.log("info", `execute: ${cmd}`) })
                    .on("stderr", (output: string) => { cli?.log("debug", `ffmpeg: ${output}`) })
                    .on("error", (err: Error) => { reject(err) })
                    .on("end", () => { resolve(true) })
                    .run()
            })
        }

        /*  concatenate cutted videos of all replay slots  */
        cli?.log("info", "command: EXPORT: video-faded all-in-one replay video")
        await ffmpegConcat({
            concurrency: 8,
            cleanupFrames: true,
            output: args.output!,
            videos: replays.map((i) => slotName(i, "overlayed")),
            transition: {
                name:     transitions[transition].name,
                duration: transitions[transition].time,
                ...(transitions[transition].params ? { params: transitions[transition].params } : {})
            }
        }).catch((err: Error) => {
            cli!.log("error", `command: EXPORT: FFmpeg: ${err}`)
            return true
        })

        /*  indicate end processing  */
        progress = false
        notifyState()
        cli?.log("info", "command: EXPORT: FFmpeg process: end")
    }

    /*  command function: preview exported replay slots  */
    const cmdPreview = async () => {
        cli?.log("info", "command: PREVIEW: open exported video")
        progress = true
        notifyState()
        await execa(args.losslesscut!, [ "--settings-json", losslessCutSettings, args.output! ], {
            stdio:       "ignore",
            detached:    true,
            windowsHide: false
        }).catch((err: Error) => {
            cli!.log("error", `command: PREVIEW: LosslessCut: ${err}`)
            return true
        })
        progress = false
        notifyState()
    }

    /*  establish network service  */
    cli!.log("info", `main: starting HAPI HTTP/WebSocket service on ${args.httpAddr}:${args.httpPort}`)
    const server = new Server({ address: args.httpAddr, port: args.httpPort })
    await server.register({ plugin: HAPIWebSocket })

    /*  hook into network service logging  */
    server.events.on("response", (request: HAPI.Request) => {
        let protocol = `HTTP/${request.raw.req.httpVersion}`
        const ws = request.websocket()
        if (ws.mode === "websocket") {
            const wsVersion = (ws.ws as any).protocolVersion ??
                request.headers["sec-websocket-version"] ?? "13?"
            protocol = `WebSocket/${wsVersion}+${protocol}`
        }
        const msg =
            "remote="   + request.info.remoteAddress + ", " +
            "method="   + request.method.toUpperCase() + ", " +
            "url="      + request.url.pathname + ", " +
            "protocol=" + protocol + ", " +
            "response=" + ("statusCode" in request.response ? request.response.statusCode : "<unknown>")
        cli!.log("info", `HAPI: request: ${msg}`)
    })
    server.events.on({ name: "request", channels: [ "error" ] },
        (request: HAPI.Request, event: HAPI.RequestEvent, _tags: { [key: string]: true }) => {
        const error = (event.error instanceof Error ? event.error.message : `${event.error}`)
        cli!.log("error", `HAPI: ${error}`)
    })
    server.events.on("log", (event: HAPI.LogEvent, tags: { [key: string]: true }) => {
        if (tags.error) {
            const error = (event.error instanceof Error ? event.error.message : `${event.error}`)
            cli!.log("error", `HAPI: ${error}`)
        }
    })

    /*  serve WebSocket connections  */
    const WebSocketCommand = type({ cmd: "string", slot: "number" })
    server.route({
        method: "POST",
        path:   "/ws",
        options: {
            plugins: {
                websocket: {
                    only: true,
                    autoping: 30 * 1000,

                    /*  on WebSocket connection open  */
                    connect: (args: any) => {
                        const ctx: wsPeerCtx            = args.ctx
                        const ws:  WebSocket            = args.ws
                        const req: http.IncomingMessage = args.req
                        const id = `${req.socket.remoteAddress}:${req.socket.remotePort}`
                        ctx.id = id
                        wsPeers.set(id, { ctx, ws, req })
                        cli!.log("info", `HAPI: WebSocket: connect: remote=${id}`)
                        notifyState()
                    },

                    /*  on WebSocket connection close  */
                    disconnect: (args: any) => {
                        const ctx: wsPeerCtx = args.ctx
                        const id = ctx.id
                        wsPeers.delete(id)
                        cli!.log("info", `HAPI: WebSocket: disconnect: remote=${id}`)
                    }
                }
            }
        },
        handler: async (request: HAPI.Request, h: HAPI.ResponseToolkit) => {
            if (typeof request.payload !== "object" || request.payload === null)
                return Boom.badRequest("invalid request")
            const { data, problems } = WebSocketCommand(request.payload)
            if (data === undefined)
                return Boom.badRequest(`invalid request: ${problems.join("; ")}`)
            if (data.cmd === "EDIT" && 1 <= data.slot && data.slot <= args.queueSlots!)
                await cmdEdit(data.slot)
            else if (data.cmd === "CLEAR" && 1 <= data.slot && data.slot <= args.queueSlots!)
                await cmdClear(data.slot)
            else if (data.cmd === "TRANSITION" && data.slot === 0)
                await cmdTransition()
            else if (data.cmd === "EXPORT" && data.slot === 0)
                await cmdExport()
            else if (data.cmd === "PREVIEW" && data.slot === 0)
                await cmdPreview()
            else
                return Boom.badRequest("invalid command in request")
            return h.response({}).code(200)
        }
    })

    /*  start HAPI service  */
    await server.start()

    /*  watch the input directory  */
    cli.log("info", `main: start watching input directory "${args.input}"`)
    const watcher = chokidar.watch(args.input!, {
        persistent: true,
        awaitWriteFinish: {
            stabilityThreshold: 1500,
            pollInterval: 50
        }
    })
    watcher.on("error", (error: Error) => {
        cli!.log("error", `main: error watching input directory: ${error.message}`)
    })
    let queue = Promise.resolve()
    watcher.on("add", async (p: string) => {
        const file = path.basename(p)
        if (!file.match(args.inputRegex!))
            return
        queue = queue.then(async () => {
            const slot = await slotFree()
            const slotPath = slotName(slot)
            cli!.log("info", `main: new input file "${file}": taking over into process slot #${slot}`)
            await fs.promises.rename(p, slotPath)
            slotState[slot - 1] = SlotStates.UNCUTTED
            notifyState()
        })
    })

    /*  catch CTRL-C  */
    process.on("SIGINT", async () => {
        cli!.log("error", "main: process interrupted (SIGINT) -- terminating process")
        await server.stop()
        await watcher.close()
        process.exit(1)
    })
})().catch((err: Error) => {
    if (cli !== null)
        cli.log("error", err.message)
    else
        process.stderr.write(`${pkg.name}: ERROR: ${err.message}\n`)
    process.exit(1)
})

