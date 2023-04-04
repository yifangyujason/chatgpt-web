import * as dotenv from 'dotenv'
import 'isomorphic-fetch'
import type { ChatGPTAPIOptions, ChatMessage, SendMessageOptions } from 'chatgpt'
import { ChatGPTAPI, ChatGPTUnofficialProxyAPI } from 'chatgpt'
import { SocksProxyAgent } from 'socks-proxy-agent'
import httpsProxyAgent from 'https-proxy-agent'
import fetch from 'node-fetch'
import { sendResponse,loadBalancer, parseKeys,sleep } from '../utils'
import { isNotEmptyString } from '../utils/is'
import type { ApiModel, ChatContext, ChatGPTUnofficialProxyAPIOptions, ModelConfig } from '../types'
import type { BalanceResponse, RequestOptions } from './types'
import LRUMap from 'lru-cache'

const { HttpsProxyAgent } = httpsProxyAgent

// 创建一个LRUMap实例，设置最大容量为1000，过期时间为1小时
const ipCache = new LRUMap<string, string>({ max: 1000, maxAge: 60 * 60 * 1000  })

dotenv.config()

const ErrorCodeMessage: Record<string, string> = {
  401: '[OpenAI] 提供错误的API密钥 | Incorrect API key provided',
  403: '[OpenAI] 服务器拒绝访问，请稍后再试 | Server refused to access, please try again later',
  502: '[OpenAI] 错误的网关 |  Bad Gateway',
  503: '[OpenAI] 服务器繁忙，请稍后再试 | Server is busy, please try again later',
  504: '[OpenAI] 网关超时 | Gateway Time-out',
  500: '[OpenAI] 服务器繁忙，请稍后再试 | Internal Server Error',
}

const timeoutMs: number = !isNaN(+process.env.TIMEOUT_MS) ? +process.env.TIMEOUT_MS : 30 * 1000
const disableDebug: boolean = process.env.OPENAI_API_DISABLE_DEBUG === 'true'

let apiModel: ApiModel

if (!isNotEmptyString(process.env.OPENAI_API_KEY) && !isNotEmptyString(process.env.OPENAI_ACCESS_TOKEN))
  throw new Error('Missing OPENAI_API_KEY or OPENAI_ACCESS_TOKEN environment variable')

let api: ChatGPTAPI | ChatGPTUnofficialProxyAPI

const accessTokens = parseKeys(process.env.OPENAI_ACCESS_TOKEN)

// 为提高性能，预先计算好能预先计算好的
// 该实现不支持中途切换 API 模型
/*const nextKey = (() => {
	const next = loadBalancer(accessTokens)
	return () => (api as ChatGPTUnofficialProxyAPI).accessToken = next()

})()*/
const maxRetry: number = !isNaN(+process.env.MAX_RETRY) ? +process.env.MAX_RETRY : accessTokens.length
const retryIntervalMs = !isNaN(+process.env.RETRY_INTERVAL_MS) ? +process.env.RETRY_INTERVAL_MS : 1000;

(async () => {
  // More Info: https://github.com/transitive-bullshit/chatgpt-api

  if (isNotEmptyString(process.env.OPENAI_API_KEY)) {
    const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL
    const OPENAI_API_MODEL = process.env.OPENAI_API_MODEL
    const model = isNotEmptyString(OPENAI_API_MODEL) ? OPENAI_API_MODEL : 'gpt-3.5-turbo'

    const options: ChatGPTAPIOptions = {
      apiKey: process.env.OPENAI_API_KEY,
      completionParams: { model },
      debug: !disableDebug,
    }

    // increase max token limit if use gpt-4
    if (model.toLowerCase().includes('gpt-4')) {
      // if use 32k model
      if (model.toLowerCase().includes('32k')) {
        options.maxModelTokens = 32768
        options.maxResponseTokens = 8192
      }
      else {
        options.maxModelTokens = 8192
        options.maxResponseTokens = 2048
      }
    }

    if (isNotEmptyString(OPENAI_API_BASE_URL))
      options.apiBaseUrl = `${OPENAI_API_BASE_URL}/v1`

    setupProxy(options)

    api = new ChatGPTAPI({ ...options })
    apiModel = 'ChatGPTAPI'
  }
  else {
    const OPENAI_API_MODEL = process.env.OPENAI_API_MODEL
    const options: ChatGPTUnofficialProxyAPIOptions = {
      accessToken: process.env.OPENAI_ACCESS_TOKEN,
      debug: !disableDebug,
    }

    if (isNotEmptyString(OPENAI_API_MODEL))
      options.model = OPENAI_API_MODEL

    options.apiReverseProxyUrl = isNotEmptyString(process.env.API_REVERSE_PROXY)
      ? process.env.API_REVERSE_PROXY
      : 'https://bypass.churchless.tech/api/conversation'

    setupProxy(options)

    api = new ChatGPTUnofficialProxyAPI({ ...options })
    apiModel = 'ChatGPTUnofficialProxyAPI'
  }
})()

async function chatReplyProcess(options: RequestOptions) {
  const { message, lastContext, process, systemMessage,clientIP } = options
  try {
    let options: SendMessageOptions = { timeoutMs }

    if (apiModel === 'ChatGPTAPI') {
      if (isNotEmptyString(systemMessage))
        options.systemMessage = systemMessage
    }
		console.log('打印出lastContext:',lastContext)

		//查询ip缓存中是否有token
		let ipToken = ipCache.get(clientIP);
    if (lastContext != null) {
      if (apiModel === 'ChatGPTAPI')
        options.parentMessageId = lastContext.parentMessageId
      else{
				if (ipToken) {
					//有token才赋值上下文
					options = {...lastContext}
				}
			}

    }

		if (apiModel === 'ChatGPTUnofficialProxyAPI') {
			//console.log('Client IP:', clientIP) // 打印客户端IP地址
			if (process)
				options.onProgress = process
			console.log('打印出options:',options)
			let retryCount = 0
			let response: ChatMessage | void

			console.log('Client IP:', clientIP) // 打印客户端IP地址

			while (!response && retryCount++ < maxRetry) {
				// 将客户端IP地址存储到LRUMap中
				if (!ipToken) {
					//没有在缓存里,获取一个新的保存
					ipToken = loadBalancer(accessTokens)()
					ipCache.set(clientIP, ipToken)
					console.log('新ip保存下token:',ipToken)
				}
				//重新赋值
				(api as ChatGPTUnofficialProxyAPI).accessToken = ipToken
				await api.sendMessage(message, options).catch((error: any) => {
					// 429 Too Many Requests
					if (error.statusCode === 404){
						console.log('报错了404',error)
						console.log('报错了404，options：',options)
						delete options.conversationId;
						delete options.parentMessageId;
						console.log('报错了404，options新对象：',options)
					}else if (error.statusCode !== 429)
						throw error

				}) = response
				console.log('报错了重新执行',retryCount)
				await sleep(retryIntervalMs)
			}
			return sendResponse({ type: 'Success', data: response })
		}


    const response = await api.sendMessage(message, {
      ...options,
      onProgress: (partialResponse) => {
        process?.(partialResponse)
      },
    })

    return sendResponse({ type: 'Success', data: response })
  }
  catch (error: any) {
    const code = error.statusCode
    global.console.log(error)
    if (Reflect.has(ErrorCodeMessage, code))
      return sendResponse({ type: 'Fail', message: ErrorCodeMessage[code] })
    return sendResponse({ type: 'Fail', message: error.message ?? 'Please check the back-end console' })
  }
}

async function fetchBalance() {
	// 计算起始日期和结束日期
	const now = new Date();
	const startDate = new Date(now - 90 * 24 * 60 * 60 * 1000);
	const endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);

	const OPENAI_API_KEY = process.env.OPENAI_API_KEY
	const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL

  if (!isNotEmptyString(OPENAI_API_KEY))
    return Promise.resolve('-')

  const API_BASE_URL = isNotEmptyString(OPENAI_API_BASE_URL)
    ? OPENAI_API_BASE_URL
    : 'https://api.openai.com'

	// 设置API请求URL和请求头
	const urlSubscription = `${API_BASE_URL}/v1/dashboard/billing/subscription`; // 查是否订阅
	const urlBalance = `${API_BASE_URL}/dashboard/billing/credit_grants`; // 查普通账单
	const urlUsage = `${API_BASE_URL}/v1/dashboard/billing/usage?start_date=${formatDate(startDate)}&end_date=${formatDate(endDate)}`; // 查使用量
	const headers = {
		"Authorization": "Bearer " + OPENAI_API_KEY,
		"Content-Type": "application/json"
	};

  try {
		// 获取API限额
		let response = await fetch(urlSubscription, {headers});

		if (!response.ok) {
			console.log("您的账户已被封禁，请登录OpenAI进行查看。");
			return;
		}
		const subscriptionData = await response.json();
		const totalAmount = subscriptionData.hard_limit_usd;

		// 获取已使用量
		response = await fetch(urlUsage, {headers});
		const usageData = await response.json();
		const totalUsage = usageData.total_usage / 100;

		// 计算剩余额度
		const balance = totalAmount - totalUsage;

		// 输出余额信息
		console.log(`balance: ${balance.toFixed(3)}`);
		console.log(`使用量: ${totalUsage.toFixed(3)}`);

		return Promise.resolve(balance.toFixed(3))

  }
  catch {
    return Promise.resolve('-')
  }
}


function formatDate(date) {
	const year = date.getFullYear();
	const month = (date.getMonth() + 1).toString().padStart(2, '0');
	const day = date.getDate().toString().padStart(2, '0');

	return `${year}-${month}-${day}`;
}


async function fetchUsage() {
	// 计算起始日期和结束日期

	const OPENAI_API_KEY = process.env.OPENAI_API_KEY
	const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL

	if (!isNotEmptyString(OPENAI_API_KEY))
		return Promise.resolve('-')

	const API_BASE_URL = isNotEmptyString(OPENAI_API_BASE_URL)
		? OPENAI_API_BASE_URL
		: 'https://api.openai.com'

	const [startDate, endDate] = formatDateUse()

	// 每月使用量
	const urlUsage = `${API_BASE_URL}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`

	const headers = {
		'Authorization': `Bearer ${OPENAI_API_KEY}`,
		'Content-Type': 'application/json',
	}

	try {
		// 获取已使用量
		const useResponse = await fetch(urlUsage, { headers })
		const usageData = await useResponse.json() as BalanceResponse
		const usage = Math.round(usageData.total_usage) / 100
		console.log(`每月使用量: ${usage}`);
		return Promise.resolve(usage ? `$${usage}` : '-')
	}
	catch {
		return Promise.resolve('-')
	}
}

function formatDateUse(): string[] {
	const today = new Date()
	const year = today.getFullYear()
	const month = today.getMonth() + 1
	const lastDay = new Date(year, month, 0)
	const formattedFirstDay = `${year}-${month.toString().padStart(2, '0')}-01`
	const formattedLastDay = `${year}-${month.toString().padStart(2, '0')}-${lastDay.getDate().toString().padStart(2, '0')}`
	return [formattedFirstDay, formattedLastDay]
}

async function chatConfig() {
  const balance = await fetchBalance()
  //const usage = await fetchUsage()
  const reverseProxy = process.env.API_REVERSE_PROXY ?? '-'
  const httpsProxy = (process.env.HTTPS_PROXY || process.env.ALL_PROXY) ?? '-'
  const socksProxy = (process.env.SOCKS_PROXY_HOST && process.env.SOCKS_PROXY_PORT)
    ? (`${process.env.SOCKS_PROXY_HOST}:${process.env.SOCKS_PROXY_PORT}`)
    : '-'
  return sendResponse<ModelConfig>({
    type: 'Success',
    data: { apiModel, reverseProxy, timeoutMs, socksProxy, httpsProxy, balance },
  })
}

function setupProxy(options: ChatGPTAPIOptions | ChatGPTUnofficialProxyAPIOptions) {
  if (isNotEmptyString(process.env.SOCKS_PROXY_HOST) && isNotEmptyString(process.env.SOCKS_PROXY_PORT)) {
    const agent = new SocksProxyAgent({
      hostname: process.env.SOCKS_PROXY_HOST,
      port: process.env.SOCKS_PROXY_PORT,
      userId: isNotEmptyString(process.env.SOCKS_PROXY_USERNAME) ? process.env.SOCKS_PROXY_USERNAME : undefined,
      password: isNotEmptyString(process.env.SOCKS_PROXY_PASSWORD) ? process.env.SOCKS_PROXY_PASSWORD : undefined,
    })
    options.fetch = (url, options) => {
      return fetch(url, { agent, ...options })
    }
  }
  else {
    if (isNotEmptyString(process.env.HTTPS_PROXY) || isNotEmptyString(process.env.ALL_PROXY)) {
      const httpsProxy = process.env.HTTPS_PROXY || process.env.ALL_PROXY
      if (httpsProxy) {
        const agent = new HttpsProxyAgent(httpsProxy)
        options.fetch = (url, options) => {
          return fetch(url, { agent, ...options })
        }
      }
    }
  }
}

function currentModel(): ApiModel {
  return apiModel
}

export type { ChatContext, ChatMessage }

export { chatReplyProcess, chatConfig, currentModel }
