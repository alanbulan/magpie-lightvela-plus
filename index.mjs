// LightVela（国内版 + 国际版）→ an OpenAI-compatible provider for magpie / OpenCode.
//
// 一个插件同时支持 LightVela 的两个版本，登录时按你账号所在的版本选入口：
//   - 国内版（lightvela.com）：手机号短信验证码登录，或粘贴会话 token；
//   - 国际版（lightvela.ai）：只有 Google 登录，在网页登录后粘贴会话 token
//     （lc_session）；实例读取通道不可用时，还可以直接粘贴 token + API key。
//
// 登录后插件会自动把账号里那个 OpenAI 兼容端点的 API key 读出来，交给
// magpie 当一个普通 provider 用 —— 不用再手动走「云存储 → 下载 .env →
// 找 key」那一串。自动读取走的正是控制台「云存储」同款的文件通道
// （tat/session + websocket + BSON 帧），debug/exec 只作回退。会话 token
// 只用来读你自己账号的实例配置、积分与活跃进度，不外发。
//
// 额度查询、每日打卡（活跃 + 续期奖励领取）两个版本共用同一套逻辑，只是
// 接口域名不同。本插件合并自社区插件 magpie-lightvela（ikashana，MIT）
// 的国内版实现与它的国际版适配，许可证见 LICENSE。
//
// 插卡式：`magpie plugin rm lightvela-plus` 或删掉本目录即彻底消失，
// magpie 的其它 provider 与配置一概不动。

import { createServer } from "node:http"

const PROVIDER = "lightvela-plus"

// 两个版本的端点。账号登录时选定版本，之后所有调用都按账号存下的版本走。
const EDITIONS = {
  cn: {
    id: "cn",
    label: "国内版",
    api: "https://api.lightvela.com",
    site: "https://lightvela.com",
    tokenBase: "https://token.lightvela.com/v1",
  },
  intl: {
    id: "intl",
    label: "国际版",
    api: "https://api.lightvela.ai",
    site: "https://lightvela.ai",
    tokenBase: "https://token.lightvela.ai/v1",
  },
}
const ICON = `${EDITIONS.intl.site}/lightvela-icon.png`
const SIGN_IN_TIMEOUT = 5 * 60_000
const USAGE_TTL = 5 * 60_000

function edOf(meta) {
  return EDITIONS[meta?.edition] ?? EDITIONS.intl
}

// 登录前先声明这两个，登录后 magpie 会拿账号自己的 /v1/models 覆盖它。
const SEED_MODELS = [
  { id: "auto", name: "Auto（自动选路）", context: 128000 },
  { id: "deepseek-v4-pro-202606", name: "DeepSeek V4 Pro", context: 128000 },
]

// 平台对模型的展示名：`/v1/models` 只给 id，这里补一份好看的。
const NAMES = {
  auto: "Auto（自动选路）",
  "deepseek-v4-pro-202606": "DeepSeek V4 Pro",
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const trim = (v) => (typeof v === "string" ? v.trim() : "")
const nameOf = (id) => NAMES[id] || id

// ---------------------------------------------------------------- LightVela API

async function call(ed, path, { method = "GET", body, token, signal } = {}) {
  const attempt = async (headers) => {
    const res = await fetch(ed.api + path, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { res, data }
  }
  const base = {}
  if (body !== undefined) base["Content-Type"] = "application/json"
  // 鉴权两种方式都兜住：lc_session 的值即会话令牌，Bearer 是原版一直用的
  // 方式；国际版实测仅凭 lc_session Cookie 也能调用。先 Bearer，被拒
  // （401）再换 Cookie 方式重试一次。
  let { res, data } = await attempt(token ? { ...base, Authorization: `Bearer ${token}` } : base)
  if (token && res.status === 401) {
    ;({ res, data } = await attempt({ ...base, Cookie: `lc_session=${token}` }))
  }
  if (!res.ok) {
    const raw =
      data?.error?.message ?? data?.message ?? data?.error ?? (typeof data === "string" ? data : "")
    const err = new Error(trim(String(raw)) || `LightVela answered ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

// sessionToken 在 /auth/sms/verify 和 /auth/session 的两种外形里都见过。
function tokenOf(payload) {
  const seen = [payload, payload?.session, payload?.data, payload?.data?.session]
  for (const box of seen) {
    const t = trim(box?.sessionToken ?? box?.session_token ?? box?.token)
    if (t) return t
  }
  return ""
}

function userOf(payload) {
  return payload?.user ?? payload?.session?.user ?? payload?.data?.user ?? null
}

// 云端实例里读 .env：只要 CUSTOM_API_KEY 与 CUSTOM_BASE_URL 两行，别的都不碰。
const READ_ENV = `set -e
ENV="\${HERMES_HOME:-$HOME/.hermes}/.env"
if [ ! -f "$ENV" ]; then echo "NO_ENV"; exit 0; fi
K=$(grep -E '^[[:space:]]*CUSTOM_API_KEY=' "$ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d '\\r')
B=$(grep -E '^[[:space:]]*CUSTOM_BASE_URL=' "$ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d '\\r')
printf 'KEY=%s\\nBASE=%s\\n' "$K" "$B"`

// 从账号里挑一个能读的实例：Running 优先，其次任何一个。
async function pickInstance(ed, token) {
  const list = await call(ed, "/v1/instances?page=1&page_size=100", { token })
  const items = list?.data?.items ?? list?.items ?? []
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`这个 LightVela 账号下还没有 Agent 实例，先在 ${ed.site.replace("https://", "")} 建一个再来`)
  }
  const usable = items.filter((i) => i && i.instance_id)
  const running = usable.find((i) => String(i.status).toLowerCase() === "running")
  return running ?? usable[0]
}

// ------------------------------------------------------------ 极简 BSON 编解码
// 文件通道的请求/响应帧是 BSON 文档。插件保持零依赖，这里只实现通道用到的
// 类型：double / string / 子文档 / 数组 / Binary / bool / 时间戳 / null /
// int32 / int64 / decimal128（近似读成 number）。
class BsonWriter {
  constructor() {
    this.bytes = []
  }
  u8(v) {
    this.bytes.push(v & 0xff)
  }
  i32(v) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setInt32(0, v, true)
    this.bytes.push(...b)
  }
  f64(v) {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, v, true)
    this.bytes.push(...b)
  }
  raw(arr) {
    for (const x of arr) this.bytes.push(x)
  }
  cstr(s) {
    this.raw(new TextEncoder().encode(s))
    this.u8(0)
  }
  str(s) {
    const e = new TextEncoder().encode(s)
    this.i32(e.length + 1)
    this.raw(e)
    this.u8(0)
  }
}

function bsonElement(w, name, value) {
  if (typeof value === "string") {
    w.u8(0x02)
    w.cstr(name)
    w.str(value)
  } else if (typeof value === "boolean") {
    w.u8(0x08)
    w.cstr(name)
    w.u8(value ? 1 : 0)
  } else if (typeof value === "number") {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      w.u8(0x10)
      w.cstr(name)
      w.i32(value)
    } else {
      w.u8(0x01)
      w.cstr(name)
      w.f64(value)
    }
  } else if (value === null || value === undefined) {
    w.u8(0x0a)
    w.cstr(name)
  } else if (value instanceof Uint8Array) {
    w.u8(0x05)
    w.cstr(name)
    w.i32(value.length)
    w.u8(0)
    w.raw(value)
  } else if (Array.isArray(value)) {
    w.u8(0x04)
    w.cstr(name)
    const sub = {}
    value.forEach((v, i) => (sub[String(i)] = v))
    w.raw(bsonEncode(sub))
  } else if (typeof value === "object") {
    w.u8(0x03)
    w.cstr(name)
    w.raw(bsonEncode(value))
  } else {
    throw new Error("bson: unsupported value type")
  }
}

function bsonEncode(doc) {
  const body = new BsonWriter()
  for (const [k, v] of Object.entries(doc)) bsonElement(body, k, v)
  const head = new BsonWriter()
  head.i32(body.bytes.length + 5)
  const out = new Uint8Array(4 + body.bytes.length + 1)
  out.set(head.bytes, 0)
  out.set(body.bytes, 4)
  out[out.length - 1] = 0
  return out
}

function bsonDecode(input, offset = 0) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const total = dv.getInt32(offset, true)
  const end = offset + total - 1
  let p = offset + 4
  const out = {}
  const dec = new TextDecoder()
  const readCStr = () => {
    const s = p
    while (u8[p] !== 0) p++
    const str = dec.decode(u8.subarray(s, p))
    p++
    return str
  }
  const readStr = () => {
    const n = dv.getInt32(p, true)
    p += 4
    const str = dec.decode(u8.subarray(p, p + n - 1))
    p += n
    return str
  }
  while (p < end) {
    const type = u8[p++]
    const name = readCStr()
    switch (type) {
      case 0x01:
        out[name] = dv.getFloat64(p, true)
        p += 8
        break
      case 0x02:
        out[name] = readStr()
        break
      case 0x03: {
        const sub = bsonDecode(u8, p)
        out[name] = sub.value
        p += sub.length
        break
      }
      case 0x04: {
        const sub = bsonDecode(u8, p)
        const arr = []
        for (const k of Object.keys(sub.value).sort((a, b) => Number(a) - Number(b))) {
          arr.push(sub.value[k])
        }
        out[name] = arr
        p += sub.length
        break
      }
      case 0x05: {
        const n = dv.getInt32(p, true)
        p += 4
        const subtype = u8[p++]
        if (subtype === 2) {
          const inner = dv.getInt32(p, true)
          p += 4
          out[name] = u8.slice(p, p + inner)
          p += inner
        } else {
          out[name] = u8.slice(p, p + n)
          p += n
        }
        break
      }
      case 0x07:
        out[name] = [...u8.subarray(p, p + 12)].map((x) => x.toString(16).padStart(2, "0")).join("")
        p += 12
        break
      case 0x08:
        out[name] = u8[p++] !== 0
        break
      case 0x09:
      case 0x11:
      case 0x12:
        out[name] = Number(dv.getBigInt64(p, true))
        p += 8
        break
      case 0x0a:
        out[name] = null
        break
      case 0x0b:
        readCStr()
        readCStr()
        out[name] = null
        break
      case 0x0d:
        out[name] = readStr()
        break
      case 0x0f: {
        const n = dv.getInt32(p, true)
        p += n
        out[name] = null
        break
      }
      case 0x10:
        out[name] = dv.getInt32(p, true)
        p += 4
        break
      case 0x13:
        out[name] = dv.getFloat64(p, true)
        p += 16
        break
      case 0x7f:
      case 0xff:
        break
      default:
        throw new Error(`bson: unknown element type 0x${type.toString(16)}`)
    }
  }
  return { value: out, length: total }
}

// ------------------------------------------------------------ 云存储文件通道
// 控制台「云存储」对话框走的是另一套通道：先 POST /v1/instances/{id}/tat/session
// 拿连接参数，再连上腾讯云 TAT 的 websocket，用 BSON 帧读文件（PtyReadFile）。
// 它和 debug/exec 是两个独立的中继——exec 那个坏掉（502）的时候这条照常工作
// （2026-11-16 在国际版实测：列目录、读 .env 全通）。插件首选这条通道读
// .env，失败了再回退 debug/exec。
const ENV_PATH = "/home/agentuser/.hermes/.env"

function parseEnvText(text) {
  const grab = (name) => {
    const m = new RegExp(`^[ \\t]*${name}=(.*)$`, "m").exec(text)
    return trim(m?.[1]).replace(/"/g, "").replace(/\r$/, "")
  }
  return { key: grab("CUSTOM_API_KEY"), base: grab("CUSTOM_BASE_URL") }
}

async function readEnvViaFileChannel(ed, token, inst) {
  if (typeof WebSocket === "undefined") throw new Error("当前运行环境没有 WebSocket，文件通道不可用")
  const bootRes = await call(ed, `/v1/instances/${encodeURIComponent(inst.instance_id)}/tat/session`, {
    method: "POST",
    token,
  })
  const b = bootRes?.data ?? bootRes
  if (!b?.wsUrl || !b?.sessionId) throw new Error("tat/session 没有返回连接信息")
  const channelId = `file-${b.sessionId}`
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(b.wsUrl)
    ws.binaryType = "arraybuffer"
    let settled = false
    const chunks = []
    const reqId = `file_${Date.now().toString(36)}_env`
    const timer = setTimeout(() => done(new Error("文件通道超时")), 45_000)
    function done(err, text) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.send(JSON.stringify({ Type: "PtyStop", Data: { SessionId: b.sessionId, ChannelId: channelId } }))
      } catch {}
      try {
        ws.close()
      } catch {}
      if (err) reject(err)
      else resolve(text)
    }
    ws.onopen = () => {
      try {
        ws.send(
          JSON.stringify({
            Type: "SessionAuth",
            Data: { Uin: b.ownerUin, AppId: b.appId, InstanceId: b.instanceId, SessionId: b.sessionId },
          }),
        )
        setTimeout(() => {
          try {
            ws.send(
              JSON.stringify({
                Type: "PtyStart",
                Data: {
                  SessionId: b.sessionId,
                  ChannelId: channelId,
                  UserName: "",
                  Cols: b.cols ?? 120,
                  Rows: b.rows ?? 32,
                  NoShell: true,
                  MaxIdleTime: b.timeoutSeconds ?? 3600,
                },
              }),
            )
          } catch {}
        }, 300)
      } catch (e) {
        done(e)
      }
    }
    ws.onmessage = (ev) => {
      let doc = null
      try {
        doc = typeof ev.data === "string" ? JSON.parse(ev.data) : bsonDecode(new Uint8Array(ev.data)).value
      } catch {
        return
      }
      const type = typeof doc?.Type === "string" ? doc.Type : ""
      if (type === "PtyError" || type === "Error") {
        done(new Error("文件通道被实例拒绝"))
        return
      }
      if (type === "PtyReady") {
        try {
          ws.send(
            bsonEncode({
              Type: "PtyReadFile",
              Data: {
                SessionId: b.sessionId,
                ChannelId: channelId,
                CustomData: reqId,
                Data: { Path: ENV_PATH, Offset: 0, Size: 1048576 },
              },
            }),
          )
        } catch (e) {
          done(e)
        }
        return
      }
      const inner = doc?.Data && typeof doc.Data === "object" ? doc.Data : null
      if (!inner || inner.CustomData !== reqId) return
      const payload = inner.Data && typeof inner.Data === "object" ? inner.Data : {}
      if (typeof payload.Error === "string" && payload.Error) {
        done(new Error(payload.Error))
        return
      }
      const bytes = payload.Data instanceof Uint8Array ? payload.Data : new Uint8Array(0)
      chunks.push({
        bytes,
        offset: Number(payload.Offset ?? 0),
        length: Number(payload.Length ?? bytes.length),
      })
      if (payload.IsLast === true) {
        chunks.sort((x, y) => x.offset - y.offset)
        const total = chunks.reduce((s, c) => Math.max(s, c.offset + c.length), 0)
        const buf = new Uint8Array(total)
        for (const c of chunks) buf.set(c.bytes.subarray(0, c.length), c.offset)
        done(null, new TextDecoder().decode(buf))
      }
    }
    ws.onerror = () => done(new Error("文件通道连接失败"))
    ws.onclose = () => done(new Error("文件通道被关闭"))
  })
}

async function readKey(ed, token, log) {
  const inst = await pickInstance(ed, token)
  log?.(`LightVela (${ed.label}): reading ${inst.name || inst.instance_id} (${inst.status || "?"})`)
  // 首选云存储文件通道；通道本身报错才回退 debug/exec。文件读到了但里面没有
  // key 是确定性结论，不回退、直接报清楚。
  let fileText = null
  try {
    fileText = await readEnvViaFileChannel(ed, token, inst)
  } catch (e) {
    log?.(`LightVela (${ed.label}): file channel unavailable (${e.message}); falling back to debug/exec`)
  }
  if (fileText !== null) {
    const env = parseEnvText(fileText)
    if (!env.key) {
      throw new Error("实例的 .env 里没有 CUSTOM_API_KEY —— 这个账号可能还没配好模型")
    }
    return {
      key: env.key,
      baseURL: env.base || ed.tokenBase,
      instanceId: inst.instance_id,
      instanceName: inst.name || inst.instance_id,
    }
  }
  const out = await call(ed, `/v1/instances/${encodeURIComponent(inst.instance_id)}/debug/exec`, {
    method: "POST",
    token,
    body: { command: READ_ENV },
  })
  const text = String(out?.data?.output ?? out?.output ?? "")
  if (text.includes("NO_ENV")) {
    throw new Error("这个实例里还没有 .env（实例可能刚创建、还没初始化完），过一会儿再试")
  }
  const key = trim(/^KEY=(.*)$/m.exec(text)?.[1])
  const base = trim(/^BASE=(.*)$/m.exec(text)?.[1])
  if (!key) {
    throw new Error("实例的 .env 里没有 CUSTOM_API_KEY —— 这个账号可能还没配好模型")
  }
  return {
    key,
    baseURL: base || ed.tokenBase,
    instanceId: inst.instance_id,
    instanceName: inst.name || inst.instance_id,
  }
}

// 用 key 读一次模型列表：既拿到真名单，也顺带确认这把 key 现在能用。
async function listModels(key, baseURL) {
  const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`这把 key 现在调不通（${res.status}）：${trim(text).slice(0, 160)}`)
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  const rows = Array.isArray(data?.data) ? data.data : []
  // 只留能按 OpenAI 协议调的：`ep-*` 那类 advanced_custom 没有可用的端点类型，
  // `llmgw-mock-chat` 是平台的假模型，列出来只会让人误选。
  const usable = rows.filter((m) => {
    if (!m || typeof m.id !== "string" || !m.id) return false
    if (/mock/i.test(m.id)) return false
    // advanced_custom（ep-*）这类是平台内部端点，owned_by 不是 openai
    if (m.owned_by && m.owned_by !== "openai") return false
    const types = m.supported_endpoint_types
    if (Array.isArray(types) && types.length && !types.includes("openai")) return false
    return true
  })
  return usable.map((m) => m.id)
}

// 账号的套餐与积分：magpie 的用量卡片就用这里的数据。
async function readUsage(ed, token) {
  const payload = await call(ed, "/v1/passes", { token })
  const passes = payload?.data?.passes ?? payload?.passes ?? []
  const p = Array.isArray(passes) ? passes.find((x) => x && x.status === "active") ?? passes[0] : null
  if (!p) return null

  const total = Number(p.credit_total) || 0
  const left = Number(p.credit_available) || 0
  const used = Math.max(0, total - left)
  const windows = []
  if (total > 0) {
    const reset = Number(p.credit_next_reset_time) || 0
    windows.push({
      name: "积分",
      used: (100 * used) / total,
      amount: used,
      limit: total,
      display: `${left}/${total}`,
      unit: "credits",
      span: 30 * 24 * 3600,
      ...(reset > 0 ? { resetsAt: new Date(reset * 1000).toISOString() } : {}),
    })
  }
  // 赠送的体验积分（如果有）单独一栏，不占套餐额度。
  const freeTotal = Number(p.free_credit_total) || 0
  if (freeTotal > 0) {
    const freeLeft = Number(p.free_credit_available) || 0
    windows.push({
      name: "体验积分",
      used: (100 * (freeTotal - freeLeft)) / freeTotal,
      amount: freeTotal - freeLeft,
      limit: freeTotal,
      display: `${freeLeft}/${freeTotal}`,
      unit: "credits",
      aside: true,
    })
  }
  return {
    plan: p.bundle_name || "LightVela",
    windows,
    ...(p.expired_time ? { until: p.expired_time } : {}),
  }
}

// 当月的活跃日历：今天有没有算上、还差几天。
async function readActivity(ed, token) {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate()
  const today = `${y}-${m}-${String(now.getDate()).padStart(2, "0")}`
  const payload = await call(ed, `/v1/users/me/activity?start=${y}-${m}-01&end=${y}-${m}-${lastDay}`, { token })
  const data = payload?.data ?? {}
  const days = Array.isArray(data.days) ? data.days : []
  const hit = days.find((x) => x && x.date === today)
  return {
    activeDays: Number(data.active_days) || 0,
    requiredDays: Number(data.required_days) || 0,
    todayActive: !!hit?.active,
    today,
  }
}

// 续期奖励：eligible 才领，领不到就把原因带回来（不抛错）。
async function claimRenewal(ed, token) {
  const got = await call(ed, "/v1/passes/active-renewal/eligibility", { token })
  const d = got?.data ?? {}
  if (!d.eligible) {
    return { claimed: false, reason: d.reason || "", activeDays: d.active_days, requiredDays: d.required_days, reward: d.reward }
  }
  if (d.claim_status && d.claim_status !== "unclaimed") {
    return { claimed: false, reason: `already_${d.claim_status}` }
  }
  const res = await call(ed, "/v1/passes/active-renewal/claim", { method: "POST", token, body: {} })
  return { claimed: true, reward: d.reward, data: res?.data ?? res }
}

// 一天的活跃 = 当天有过一次模型调用。发一条最短的消息把它点着，
// 成本在 20 token 上下（1 积分 ≈ 10000 token）。
async function sendPing(key, baseURL) {
  const base = (baseURL || EDITIONS.intl.tokenBase).replace(/\/+$/, "")
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "1" }], max_tokens: 1 }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`打卡请求失败（${res.status}）：${trim(body).slice(0, 160)}`)
  }
  await res.text().catch(() => "")
  return true
}

// ------------------------------------------------------------------ sign-in pages

function pageCn() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 LightVela 国内版</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#262b36;--text:#e6e8ee;--dim:#8b93a5;--accent:#3b82f6;--ok:#22c55e;--bad:#ef4444}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .card{width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 26px 24px}
  h1{margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:.2px}
  p.sub{margin:0 0 22px;color:var(--dim);font-size:12.5px}
  label{display:block;font-size:12px;color:var(--dim);margin:0 0 6px}
  input{width:100%;padding:10px 12px;background:#0d1017;border:1px solid var(--line);border-radius:9px;color:var(--text);font-size:14px;outline:none;transition:border-color .15s}
  input:focus{border-color:var(--accent)}
  .row{display:flex;gap:8px}
  .row input{flex:1}
  button{padding:10px 14px;border:1px solid var(--line);border-radius:9px;background:#1e2330;color:var(--text);font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s}
  button:hover:not(:disabled){background:#252c3b}
  button:disabled{opacity:.45;cursor:default}
  button.primary{width:100%;margin-top:18px;background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button.primary:hover:not(:disabled){background:#2f74e8}
  .msg{margin-top:14px;font-size:12.5px;min-height:18px}
  .msg.bad{color:var(--bad)}
  .msg.ok{color:var(--ok)}
  .hint{margin-top:20px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:11.5px;line-height:1.65}
  .done{text-align:center;padding:10px 0}
  .done .tick{font-size:34px;line-height:1;color:var(--ok)}
  .done h2{margin:14px 0 6px;font-size:16px}
  .done p{margin:0;color:var(--dim);font-size:12.5px}
</style></head>
<body>
<div class="card" id="card">
  <h1>登录 LightVela 国内版</h1>
  <p class="sub">国内版（lightvela.com）· 用手机号收验证码</p>
  <label for="phone">手机号</label>
  <input id="phone" inputmode="numeric" autocomplete="tel" placeholder="11 位手机号" maxlength="11" autofocus>
  <div style="height:12px"></div>
  <label for="code">短信验证码</label>
  <div class="row">
    <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="验证码" maxlength="8">
    <button id="send">发送</button>
  </div>
  <button class="primary" id="go">登录并读取 API key</button>
  <div class="msg" id="msg"></div>
  <div class="hint">
    登录只为了读你自己账号里那个实例的 <code>CUSTOM_API_KEY</code> 与套餐积分。
    凭证不会离开这台电脑，也不会写进日志。
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id)
const msg = $("msg")
let left = 0, timer = null

function say(text, kind) {
  msg.textContent = text || ""
  msg.className = "msg" + (kind ? " " + kind : "")
}
function tick() {
  if (left <= 0) { $("send").disabled = false; $("send").textContent = "发送"; clearInterval(timer); return }
  $("send").disabled = true
  $("send").textContent = left + "s"
  left--
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok || data.ok === false) throw new Error(data.error || "请求失败")
  return data
}
$("send").onclick = async () => {
  const phone = $("phone").value.trim()
  if (!/^1[3-9]\\d{9}$/.test(phone)) return say("请输入正确的 11 位手机号", "bad")
  $("send").disabled = true
  say("正在发送…")
  try {
    const d = await post("/api/send", { phone })
    left = Math.max(1, d.cooldown || 60)
    tick(); timer = setInterval(tick, 1000)
    say("验证码已发送，注意查收短信", "ok")
    $("code").focus()
  } catch (e) {
    $("send").disabled = false
    say(e.message, "bad")
  }
}
$("go").onclick = async () => {
  const phone = $("phone").value.trim(), code = $("code").value.trim()
  if (!/^1[3-9]\\d{9}$/.test(phone)) return say("请输入正确的 11 位手机号", "bad")
  if (!/^\\d{4,8}$/.test(code)) return say("请输入短信里的验证码", "bad")
  $("go").disabled = true
  say("登录中，正在读实例配置…")
  try {
    const d = await post("/api/verify", { phone, code })
    $("card").innerHTML = '<div class="done"><div class="tick">✓</div><h2>已登录</h2><p>' +
      (d.account ? "账号：" + d.account + "<br>" : "") +
      (d.instance ? "实例：" + d.instance + "<br>" : "") +
      (d.models ? "模型：" + d.models + "<br>" : "") +
      "可以关掉这个页面了</p></div>"
  } catch (e) {
    $("go").disabled = false
    say(e.message, "bad")
  }
}
</script>
</body></html>`
}

function pageIntl() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 LightVela 国际版</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#262b36;--text:#e6e8ee;--dim:#8b93a5;--accent:#3b82f6;--ok:#22c55e;--bad:#ef4444}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .card{width:400px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 26px 24px}
  h1{margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:.2px}
  p.sub{margin:0 0 16px;color:var(--dim);font-size:12.5px}
  ol.steps{margin:0 0 20px;padding-left:20px;color:var(--dim);font-size:12.5px;line-height:1.75}
  ol.steps b{color:var(--text);font-weight:600}
  label{display:block;font-size:12px;color:var(--dim);margin:0 0 6px}
  textarea{width:100%;padding:10px 12px;background:#0d1017;border:1px solid var(--line);border-radius:9px;color:var(--text);font-size:13px;outline:none;resize:vertical;min-height:64px;font-family:ui-monospace,Menlo,Consolas,monospace;transition:border-color .15s}
  textarea:focus{border-color:var(--accent)}
  button{padding:10px 14px;border:1px solid var(--line);border-radius:9px;background:#1e2330;color:var(--text);font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s}
  button:hover:not(:disabled){background:#252c3b}
  button:disabled{opacity:.45;cursor:default}
  button.primary{width:100%;margin-top:18px;background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button.primary:hover:not(:disabled){background:#2f74e8}
  .msg{margin-top:14px;font-size:12.5px;min-height:18px}
  .msg.bad{color:var(--bad)}
  .msg.ok{color:var(--ok)}
  .hint{margin-top:20px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:11.5px;line-height:1.65}
  .done{text-align:center;padding:10px 0}
  .done .tick{font-size:34px;line-height:1;color:var(--ok)}
  .done h2{margin:14px 0 6px;font-size:16px}
  .done p{margin:0;color:var(--dim);font-size:12.5px}
</style></head>
<body>
<div class="card" id="card">
  <h1>登录 LightVela 国际版</h1>
  <p class="sub">国际版（lightvela.ai）只有 Google 登录、没有短信验证码，按下面三步把会话 token 粘进来即可。</p>
  <ol class="steps">
    <li>打开 <b>lightvela.ai</b>，用 Google 账号登录（已登录可跳过）。</li>
    <li>按 <b>F12</b> 打开开发者工具 → <b>应用（Application）</b> → 左侧 <b>Cookie</b> → 点 <b>https://api.lightvela.ai</b>。</li>
    <li>找到 <b>lc_session</b> 那一行，双击它的值复制，粘到下面。</li>
  </ol>
  <label for="token">lc_session</label>
  <textarea id="token" placeholder="把 lc_session 的值粘到这里" autofocus></textarea>
  <button class="primary" id="go">登录并读取 API key</button>
  <div class="msg" id="msg"></div>
  <div class="hint">
    登录只为了读你自己账号里那个实例的 <code>CUSTOM_API_KEY</code> 与套餐积分。
    凭证不会离开这台电脑，也不会写进日志。token 过期了重新粘一次即可。
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id)
const msg = $("msg")
function say(text, kind) {
  msg.textContent = text || ""
  msg.className = "msg" + (kind ? " " + kind : "")
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok || data.ok === false) throw new Error(data.error || "请求失败")
  return data
}
$("go").onclick = async () => {
  const token = $("token").value.trim()
  if (token.length < 10) return say("先把 lc_session 的值粘进来", "bad")
  $("go").disabled = true
  say("登录中，正在读实例配置…")
  try {
    const d = await post("/api/token", { token })
    $("card").innerHTML = '<div class="done"><div class="tick">✓</div><h2>已登录</h2><p>' +
      (d.account ? "账号：" + d.account + "<br>" : "") +
      (d.instance ? "实例：" + d.instance + "<br>" : "") +
      (d.models ? "模型：" + d.models + "<br>" : "") +
      "可以关掉这个页面了</p></div>"
  } catch (e) {
    $("go").disabled = false
    say(e.message, "bad")
  }
}
</script>
</body></html>`
}

// ---------------------------------------------------------------- sign-in server

// 起一个只监听 127.0.0.1 的小服务：登录页在这儿，平台接口由它代转，
// 登录成功后它自己把结果交回 authorize 的 callback。
// 国内版页面走短信（/api/send + /api/verify），国际版页面收 token（/api/token）。
function signInServer(ed, log) {
  return new Promise((resolve, reject) => {
    let settled = false
    let settle
    const done = new Promise((r) => (settle = r))
    const finish = (result) => {
      if (settled) return
      settled = true
      settle(result)
    }
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const json = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
        res.end(JSON.stringify(body))
      }
      const readBody = () =>
        new Promise((r) => {
          let raw = ""
          req.on("data", (c) => (raw += c))
          req.on("end", () => {
            try {
              r(JSON.parse(raw || "{}"))
            } catch {
              r({})
            }
          })
        })

      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
        return res.end(ed.id === "cn" ? pageCn() : pageIntl())
      }
      if (ed.id === "cn" && url.pathname === "/api/send" && req.method === "POST") {
        const { phone } = await readBody()
        const p = trim(phone)
        if (!/^1[3-9]\d{9}$/.test(p)) return json(400, { ok: false, error: "手机号格式不对" })
        try {
          const out = await call(ed, "/auth/sms/send", { method: "POST", body: { phone: p } })
          return json(200, { ok: true, cooldown: Number(out?.cooldownSeconds ?? out?.cooldown_seconds ?? 60) || 60 })
        } catch (e) {
          return json(400, { ok: false, error: e.message })
        }
      }
      if (ed.id === "cn" && url.pathname === "/api/verify" && req.method === "POST") {
        const { phone, code } = await readBody()
        const p = trim(phone)
        const c = trim(code)
        try {
          const payload = await call(ed, "/auth/sms/verify", { method: "POST", body: { phone: p, code: c } })
          const token = tokenOf(payload)
          if (!token) throw new Error("登录成功，但没拿到会话 token")
          const r = await resolveToken(ed, token, log)
          finish(authResult(ed, r))
          return json(200, {
            ok: true,
            account: r.account,
            instance: r.got.instanceName,
            models: r.ids.map(nameOf).join("、"),
          })
        } catch (e) {
          return json(400, { ok: false, error: e.message })
        }
      }
      if (ed.id === "intl" && url.pathname === "/api/token" && req.method === "POST") {
        const { token } = await readBody()
        try {
          const r = await resolveToken(ed, token, log)
          finish(authResult(ed, r))
          return json(200, {
            ok: true,
            account: r.account,
            instance: r.got.instanceName,
            models: r.ids.map(nameOf).join("、"),
          })
        } catch (e) {
          return json(400, { ok: false, error: e.message })
        }
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("not found")
    })

    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      const timer = setTimeout(() => {
        finish({ type: "failed", error: "登录超时了（5 分钟），再点一次重新开始" })
      }, SIGN_IN_TIMEOUT)
      done.then(() => {
        clearTimeout(timer)
        setTimeout(() => server.close(), 3_000).unref?.()
      })
      resolve({
        url: `http://127.0.0.1:${port}/`,
        instructions:
          ed.id === "cn"
            ? "在打开的页面里输入手机号和短信验证码；登录成功后它会自己关掉。"
            : "在打开的页面里按说明粘贴 lc_session；登录成功后它会自己关掉。",
        method: "auto",
        async callback() {
          return await done
        },
      })
    })
  })
}

// 粘 token 登录的共用逻辑（两个版本同一套）：验 token → 读实例 key →
// 用真 key 试一次模型列表。key 现在就不能用的话当场说清楚，
// 不要等 magpie 配好了才发现。
async function resolveToken(ed, token, log) {
  const clean = trim(token)
  if (!clean) throw new Error(`请填入 LightVela ${ed.label}的会话 token（lc_session）`)
  const got = await readKey(ed, clean, log)
  let ids
  try {
    ids = await listModels(got.key, got.baseURL)
  } catch (e) {
    log?.(`LightVela (${ed.label}): key check failed — ${e.message}`)
    throw new Error(`读到 key 了，但它现在调不通：${e.message}`)
  }
  let user = null
  try {
    user = userOf(await call(ed, "/auth/session", { token: clean }))
  } catch {}
  return {
    clean,
    got,
    ids,
    account: user?.name || user?.email || user?.phone || `LightVela ${ed.label}`,
  }
}

function authResult(ed, r) {
  return {
    type: "success",
    access: r.got.key,
    refresh: JSON.stringify({
      edition: ed.id,
      token: r.clean,
      instanceId: r.got.instanceId,
      baseURL: r.got.baseURL,
      models: r.ids,
    }),
    expires: 0,
    accountId: r.account,
  }
}

// 手动粘 token 的兜底路径：和页面里走的是同一套逻辑。
async function fromToken(ed, token, log) {
  return authResult(ed, await resolveToken(ed, token, log))
}

// exec 通道不可用时的登录路径：key 由用户直接给出，跳过读实例那一步；
// 其余校验照旧（key 必须真能拉到模型列表），token 仍用于额度和打卡。
async function resolveTokenWithKey(ed, token, key, log) {
  const clean = trim(token)
  if (!clean) throw new Error(`请填入 LightVela ${ed.label}的会话 token（lc_session）`)
  const apiKey = trim(key)
  if (!apiKey) throw new Error("请填入 API key（实例 .hermes/.env 里的 CUSTOM_API_KEY）")
  let ids
  try {
    ids = await listModels(apiKey, ed.tokenBase)
  } catch (e) {
    log?.(`LightVela (${ed.label}): pasted key check failed — ${e.message}`)
    throw new Error(`这把 key 现在调不通：${e.message}`)
  }
  if (!ids.length) throw new Error("这把 key 拉不到可用模型，确认一下是不是粘错了")
  let inst = null
  try {
    inst = await pickInstance(ed, clean)
  } catch {}
  let user = null
  try {
    user = userOf(await call(ed, "/auth/session", { token: clean }))
  } catch {}
  return {
    clean,
    got: {
      key: apiKey,
      baseURL: ed.tokenBase,
      instanceId: inst?.instance_id ?? "",
      instanceName: inst?.name ?? "",
    },
    ids,
    account: user?.name || user?.email || user?.phone || `LightVela ${ed.label}`,
  }
}

// ---------------------------------------------------------------------- plugin

function metaOf(auth) {
  try {
    const raw = auth?.refresh
    if (typeof raw === "string" && raw.trim().startsWith("{")) return JSON.parse(raw)
  } catch {}
  return {}
}

function modelEntry(m, baseURL) {
  const id = typeof m === "string" ? m : m.id
  const label = typeof m === "string" ? undefined : m.name
  const ctx = typeof m === "string" ? undefined : m.context
  return [
    id,
    {
      id,
      name: label || nameOf(id),
      provider: { npm: "@ai-sdk/openai-compatible", api: baseURL },
      limit: { context: ctx || 128000, output: 8192 },
      reasoning: true,
      tool_call: true,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
    },
  ]
}

// magpie 的 oauth 方法只认 {url, callback} 这种「流程」对象，
// 结果必须由 callback() 交回去，不能直接返回 {type:"success"}。
function promptFlow(instructions, run) {
  return {
    url: "",
    instructions,
    method: "auto",
    async callback() {
      try {
        return await run()
      } catch (e) {
        return { type: "failed", error: e.message }
      }
    },
  }
}

export async function LightVelaAuthPlugin({ client, magpie } = {}, options = {}) {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "lightvela-auth", level: "info", message } })
    } catch {}
  }
  // 积分读一次缓存几分钟，Providers 页面反复刷时不去打平台接口。
  // 缓存必须按账号分开：key 用该账号自己的会话 token——共用一份缓存的话，
  // 先刷出来的账号会把名字和积分盖到其他账号的卡片上（v0.2.2 的 bug）。
  const usageCache = new Map()

  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      const base = was.api || EDITIONS.intl.tokenBase
      cfg.provider[PROVIDER] = {
        name: "LightVela（国内+国际）",
        npm: "@ai-sdk/openai-compatible",
        api: base,
        ...was,
        models: {
          ...Object.fromEntries(SEED_MODELS.map((m) => modelEntry(m, base))),
          ...(was.models ?? {}),
        },
      }
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const meta = metaOf(auth)
        const base = meta.baseURL || provider?.api || EDITIONS.intl.tokenBase
        if (auth?.access) {
          try {
            const ids = await listModels(auth.access, base)
            if (ids.length) return Object.fromEntries(ids.map((id) => modelEntry(id, base)))
          } catch (e) {
            log(`LightVela: model list failed — ${e.message}`)
          }
        }
        const known = Array.isArray(meta.models) ? meta.models : []
        if (known.length) return Object.fromEntries(known.map((id) => modelEntry(id, base)))
        return provider?.models ?? Object.fromEntries(SEED_MODELS.map((m) => modelEntry(m, base)))
      },
    },

    auth: {
      provider: PROVIDER,
      single: false,
      icon: ICON,
      methods: [
        {
          type: "oauth",
          label: "LightVela 国内版登录（手机验证码）",
          authorize: () => signInServer(EDITIONS.cn, log),
        },
        {
          type: "oauth",
          label: "LightVela 国内版：粘贴已有会话 token",
          prompts: [
            {
              type: "text",
              key: "token",
              message: "lc_session 的值（浏览器开发者工具 → Application → Cookies → api.lightvela.com）",
            },
          ],
          authorize: (inputs) =>
            promptFlow("正在用这把会话 token 读 LightVela 国内版实例里的 key…", () =>
              fromToken(EDITIONS.cn, inputs?.token, log),
            ),
        },
        {
          type: "oauth",
          label: "LightVela 国际版登录（说明页粘贴 token）",
          authorize: () => signInServer(EDITIONS.intl, log),
        },
        {
          type: "oauth",
          label: "LightVela 国际版：直接粘贴会话 token",
          prompts: [
            {
              type: "text",
              key: "token",
              message: "lc_session 的值（浏览器开发者工具 → Application → Cookies → api.lightvela.ai）",
            },
          ],
          authorize: (inputs) =>
            promptFlow("正在用这把会话 token 读 LightVela 国际版实例里的 key…", () =>
              fromToken(EDITIONS.intl, inputs?.token, log),
            ),
        },
        {
          type: "oauth",
          label: "LightVela 国际版：粘贴 token + API key（实例读取不可用时）",
          prompts: [
            {
              type: "text",
              key: "token",
              message: "lc_session 的值（浏览器开发者工具 → Application → Cookies → api.lightvela.ai）",
            },
            {
              type: "text",
              key: "key",
              message: "API key（实例 .hermes/.env 里的 CUSTOM_API_KEY，sk- 开头）",
            },
          ],
          authorize: (inputs) =>
            promptFlow("正在校验会话 token 与 API key…", async () =>
              authResult(EDITIONS.intl, await resolveTokenWithKey(EDITIONS.intl, inputs?.token, inputs?.key, log)),
            ),
        },
      ],
      // magpie 的每日打卡：当天没活跃就打一次点，顺手把到期的续期奖励领了。
      async checkin(getAuth) {
        const auth = await getAuth()
        const meta = metaOf(auth)
        if (!meta.token) {
          return { outcome: "ineligible", message: "会话已过期，重新登录一次才能打卡" }
        }
        const ed = edOf(meta)
        try {
          let before = await readActivity(ed, meta.token)
          let pinged = false
          if (!before.todayActive) {
            // 当天还没有模型调用：发一条最短的消息把它点着
            await sendPing(auth.access, meta.baseURL)
            pinged = true
            // 平台大约 8 秒后才把它记上，最多等 20 秒
            for (let i = 0; i < 5; i++) {
              await sleep(4000)
              const a = await readActivity(ed, meta.token).catch(() => null)
              if (a?.todayActive) {
                before = a
                break
              }
            }
          }
          let renewal = null
          try {
            renewal = await claimRenewal(ed, meta.token)
          } catch (e) {
            renewal = { claimed: false, reason: e.message }
          }
          const after = await readActivity(ed, meta.token).catch(() => before)
          const bits = []
          if (renewal?.claimed) bits.push("已领取续期奖励")
          if (pinged) bits.push("已发打卡消息")
          bits.push(after.todayActive ? "今日活跃 ✓" : "今日活跃（待平台确认）")
          if (after.requiredDays > 0) bits.push(`进度 ${after.activeDays}/${after.requiredDays}`)
          if (renewal && !renewal.claimed && renewal.reason) bits.push(`续期：${renewal.reason}`)
          return { outcome: "claimed", message: bits.join(" · ") }
        } catch (e) {
          return { outcome: "failed", message: e?.message ?? String(e) }
        }
      },
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth?.access) return {}
        const meta = metaOf(auth)
        return {
          baseURL: meta.baseURL || edOf(meta).tokenBase,
          apiKey: auth.access,
        }
      },
      // magpie 的用量卡片：套餐名、积分余额、到期日。
      async usage(getAuth) {
        const auth = await getAuth()
        const meta = metaOf(auth)
        if (!auth?.access) return null
        if (!meta.token) return { plan: "LightVela", signIn: "kept" }
        const hit = usageCache.get(meta.token)
        if (hit && Date.now() - hit.at < USAGE_TTL) return hit.value
        const ed = edOf(meta)
        try {
          const got = await readUsage(ed, meta.token)
          if (!got) return { plan: "LightVela", signIn: "kept" }
          const out = { ...got, ...(auth.accountId ? { user: String(auth.accountId) } : {}), signIn: "kept" }
          usageCache.set(meta.token, { at: Date.now(), value: out })
          return out
        } catch (e) {
          if (e?.status === 401) {
            // 会话 token 过期了，但 key 还能用：只影响这张卡片和模型刷新，
            // 推理不受影响，所以不把账号标成掉线。
            return { plan: "LightVela", error: "会话已过期（key 仍可用），重新登录可恢复积分显示", signIn: "kept" }
          }
          return { plan: "LightVela", error: e.message, signIn: "kept" }
        }
      },
    },
  }
}

// for tests
export const _internal = {
  EDITIONS,
  edOf,
  call,
  tokenOf,
  userOf,
  readKey,
  readEnvViaFileChannel,
  parseEnvText,
  bsonEncode,
  bsonDecode,
  resolveToken,
  resolveTokenWithKey,
  authResult,
  pickInstance,
  listModels,
  readUsage,
  readActivity,
  claimRenewal,
  pageCn,
  pageIntl,
  metaOf,
  modelEntry,
  nameOf,
  READ_ENV,
  PROVIDER,
  ICON,
}
