// ============================================================
//  BOT WHATSAPP - FOTO LIVE
//  Perintah : .fotolive  (kirim video + caption .fotolive,
//                         atau balas video dengan .fotolive)
//  Opsi     : .fotolive 2   -> durasi 2 detik (1-5, default 3)
//  Hasil    : 1) Foto live asli WhatsApp (foto + ikon LIVE)
//             2) File "Motion Photo" .jpg (foto live asli Android)
// ============================================================

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
  generateWAMessage,
  jidNormalizedUser,
  proto,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// ---------------- KONFIGURASI ----------------
const PREFIX = '.'
const COMMAND = 'fotolive'
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const DEFAULT_DURATION = 3        // detik
const MAX_DURATION = 5            // detik
const MAX_INPUT_SECONDS = 120     // tolak video yang lebih panjang dari ini
const MAX_INPUT_BYTES = 50 * 1024 * 1024 // 50 MB
const SEND_MOTION_PHOTO = true    // kirim juga file Motion Photo (.jpg)

const logger = pino({ level: 'silent' })
const busy = new Set() // cegah 1 user memproses banyak video bersamaan

// ---------------- HELPER ----------------
const unwrap = (m) =>
  m?.ephemeralMessage?.message ??
  m?.viewOnceMessage?.message ??
  m?.viewOnceMessageV2?.message ??
  m?.documentWithCaptionMessage?.message ??
  m

function getText(m) {
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.videoMessage?.caption ||
    m?.imageMessage?.caption ||
    ''
  )
}

// Ambil video dari pesan itu sendiri atau dari pesan yang dibalas (quoted)
function getVideoMessage(m) {
  if (m?.videoMessage) return m.videoMessage
  const ctx = m?.extendedTextMessage?.contextInfo
  const quoted = unwrap(ctx?.quotedMessage)
  return quoted?.videoMessage || null
}

async function downloadVideo(videoMessage) {
  const stream = await downloadContentFromMessage(videoMessage, 'video')
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' ? 'ffmpeg tidak ditemukan. Install ffmpeg dulu.' : e.message)),
    )
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('ffmpeg gagal: ' + err.slice(-400))),
    )
  })
}

// ---------------- KONVERSI VIDEO -> FOTO LIVE ----------------
async function convertToLivePhoto(videoBuffer, duration) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fotolive-'))
  const input = path.join(dir, 'input')
  const outVideo = path.join(dir, 'live.mp4')
  const outStill = path.join(dir, 'still.jpg')

  try {
    await fs.writeFile(input, videoBuffer)

    // 1) Potong ke beberapa detik, kecilkan ke maks 720px, encode H.264 + AAC
    await run(FFMPEG, [
      '-y', '-i', input,
      '-t', String(duration),
      '-vf', "scale='trunc(min(720,iw)/2)*2':-2,fps=30",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-movflags', '+faststart',
      outVideo,
    ])

    // 2) Ambil 1 frame di tengah klip sebagai foto utama
    await run(FFMPEG, [
      '-y', '-ss', String(Math.min(duration / 2, 1.5)), '-i', outVideo,
      '-frames:v', '1', '-q:v', '2',
      outStill,
    ])

    const video = await fs.readFile(outVideo)
    const still = await fs.readFile(outStill)
    const offsetMs = Math.round(Math.min(duration / 2, 1.5) * 1000)
    return { video, still, offsetMs, motionPhoto: buildMotionPhoto(still, video) }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// Gabungkan JPEG + MP4 menjadi Google "Motion Photo" (foto live Android)
function buildMotionPhoto(jpeg, mp4) {
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.0-jc003">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
    GCamera:MotionPhoto="1"
    GCamera:MotionPhotoVersion="1"
    GCamera:MotionPhotoPresentationTimestampUs="0"
    GCamera:MicroVideo="1"
    GCamera:MicroVideoVersion="1"
    GCamera:MicroVideoOffset="${mp4.length}"
    GCamera:MicroVideoPresentationTimestampUs="0">
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="0"/>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${mp4.length}" Item:Padding="0"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`

  const header = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1')
  const body = Buffer.from(xmp, 'utf8')
  const segLen = 2 + header.length + body.length
  const app1 = Buffer.alloc(4)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1.writeUInt16BE(segLen, 2)

  // sisipkan APP1 (XMP) tepat setelah SOI (2 byte pertama), lalu tempel MP4 di akhir
  return Buffer.concat([jpeg.subarray(0, 2), app1, header, body, jpeg.subarray(2), mp4])
}

// ---------------- KIRIM FOTO LIVE ASLI WHATSAPP ----------------
// Foto live di WhatsApp = sepasang pesan: foto diam (PARENT) + klip video (CHILD)
// yang dihubungkan lewat messageAssociation. Penerima melihat foto dengan ikon LIVE.
async function sendLivePhoto(sock, jid, { still, video, offsetMs }, quoted, caption) {
  const PMT = proto.ContextInfo?.PairedMediaType
  const AT = proto.MessageAssociation?.AssociationType
  if (!PMT?.MOTION_PHOTO_PARENT || !AT?.MOTION_PHOTO) {
    throw new Error(
      'Versi Baileys ini belum mendukung foto live. Jalankan: npm install @whiskeysockets/baileys@latest sharp',
    )
  }

  const opts = {
    upload: sock.waUploadToServer,
    userJid: jidNormalizedUser(sock.user.id),
    logger,
  }

  // 1) Induk: foto diam
  const parent = await generateWAMessage(
    jid,
    { image: still, mimetype: 'image/jpeg', caption },
    { ...opts, quoted },
  )
  const imageMsg = parent.message.imageMessage
  const parentCtx = imageMsg.contextInfo || {}
  parentCtx.pairedMediaType = PMT.MOTION_PHOTO_PARENT
  imageMsg.contextInfo = parentCtx
  await sock.relayMessage(jid, parent.message, { messageId: parent.key.id })

  // 2) Anak: klip video yang terhubung ke foto di atas
  const child = await generateWAMessage(jid, { video, mimetype: 'video/mp4' }, opts)
  const videoMsg = child.message.videoMessage
  const childCtx = videoMsg.contextInfo || {}
  childCtx.pairedMediaType = PMT.MOTION_PHOTO_CHILD
  videoMsg.contextInfo = childCtx
  videoMsg.motionPhotoPresentationOffsetMs = offsetMs
  child.message.messageContextInfo = {
    messageAssociation: {
      associationType: AT.MOTION_PHOTO,
      parentMessageKey: parent.key,
      messageIndex: 1,
    },
  }
  await sock.relayMessage(jid, child.message, { messageId: child.key.id })
}

// ---------------- HANDLER PESAN ----------------
async function handleMessage(sock, msg) {
  if (!msg.message) return
  const jid = msg.key.remoteJid
  if (!jid || jid === 'status@broadcast') return

  const m = unwrap(msg.message)
  const text = getText(m).trim()
  if (!text.startsWith(PREFIX)) return

  const [cmdRaw, arg] = text.slice(PREFIX.length).split(/\s+/)
  if (cmdRaw?.toLowerCase() !== COMMAND) return

  const sender = msg.key.participant || jid
  const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: msg })

  const videoMessage = getVideoMessage(m)
  if (!videoMessage) {
    return reply(
      `🎞️ *FOTO LIVE*\n\n` +
        `Cara pakai:\n` +
        `1. Kirim video dengan caption *${PREFIX}${COMMAND}*\n` +
        `2. Atau balas video dengan *${PREFIX}${COMMAND}*\n\n` +
        `Atur durasi (1-${MAX_DURATION} detik): *${PREFIX}${COMMAND} 2*`,
    )
  }

  if ((videoMessage.seconds || 0) > MAX_INPUT_SECONDS)
    return reply(`❌ Video terlalu panjang (maks ${MAX_INPUT_SECONDS} detik).`)
  if (Number(videoMessage.fileLength || 0) > MAX_INPUT_BYTES)
    return reply(`❌ Ukuran video terlalu besar (maks ${MAX_INPUT_BYTES / 1024 / 1024} MB).`)
  if (busy.has(sender)) return reply('⏳ Tunggu, videomu yang sebelumnya masih diproses.')

  let duration = parseInt(arg, 10)
  if (!Number.isFinite(duration)) duration = DEFAULT_DURATION
  duration = Math.min(Math.max(duration, 1), MAX_DURATION)

  busy.add(sender)
  try {
    await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } })

    const buffer = await downloadVideo(videoMessage)
    const result = await convertToLivePhoto(buffer, duration)
    const { motionPhoto } = result

    // 1) Kirim sebagai foto live asli WhatsApp (foto + ikon LIVE)
    try {
      await sendLivePhoto(sock, jid, result, msg, `✅ Foto live berhasil dibuat (${duration} detik)`)
    } catch (err) {
      console.error('[fotolive] gagal kirim foto live:', err)
      await reply('⚠️ Gagal mengirim foto live: ' + (err.message || err))
    }

    // 2) Kirim file Motion Photo (bisa dibuka sebagai foto live di galeri Android)
    if (SEND_MOTION_PHOTO) {
      const name = `FOTOLIVE_${crypto.randomBytes(3).toString('hex')}.jpg`
      await sock.sendMessage(
        jid,
        { document: motionPhoto, mimetype: 'image/jpeg', fileName: name },
        { quoted: msg },
      )
    }

    await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } })
  } catch (err) {
    console.error('[fotolive] error:', err)
    await sock.sendMessage(jid, { react: { text: '❌', key: msg.key } }).catch(() => {})
    await reply('❌ Gagal mengubah video menjadi foto live.\n' + (err.message || '')).catch(() => {})
  } finally {
    busy.delete(sender)
  }
}

// ---------------- KONEKSI ----------------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['FotoLive Bot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nScan QR berikut lewat WhatsApp > Perangkat tertaut:\n')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') console.log('✅ Bot terhubung & siap dipakai!')
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('❌ Sesi logout. Hapus folder ./session lalu jalankan ulang.')
      } else {
        console.log('🔄 Koneksi terputus, mencoba menyambung ulang...')
        start()
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      handleMessage(sock, msg).catch((e) => console.error('handler error:', e))
    }
  })
}

start()
