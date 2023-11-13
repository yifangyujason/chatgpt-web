import cron from 'node-cron';
import {isNotEmptyString} from "./is";
import jwt_decode from 'jwt-decode'
import dayjs from 'dayjs'
import {parseKeys} from './index'
import {JWT} from "../types";
import {ipCache,accessTokens,setAccessTokens} from "../chatgpt";
import fetch from 'node-fetch';
import {updateEnvFile} from "./operateEnv";
import * as dotenv from 'dotenv'
import * as fs from 'fs'

dotenv.config();
// 设定定时任务的执行规律
const schedule = isNotEmptyString(process.env.TOKEN_CHECK) ? process.env.TOKEN_CHECK : '0 0 * * *';
const loginUrl = isNotEmptyString(process.env.TOKEN_LOGIN_URL) ? process.env.TOKEN_LOGIN_URL : 'http://127.0.0.1:8080/chatgpt/login';
const loginUrlOfMicros = isNotEmptyString(process.env.TOKEN_LOGIN_MICROS_URL) ? process.env.TOKEN_LOGIN_MICROS_URL : 'http://127.0.0.1:8082/getTokenOfOpenAi';
//定义用户登录信息的map
const userInfoMap = new Map<string, object>();


export async function initCron(){
	try {
		if(isNotEmptyString(process.env.TOKEN_USER_INFO)){
			console.log('启动定时任务,schedule:',schedule);
			//获取登录用户的json数组，并转化成map集合
			const userInfoArray = parseJsonString(process.env.TOKEN_USER_INFO);
			userInfoArray.forEach((userInfo: any) => {
				const username = userInfo.username;
				userInfoMap.set(username, userInfo);
			});
			cron.schedule(schedule, checkTokenExpires);
			cron.schedule(schedule, deleteFilesBeforeYesterday);
		}

	} catch(error) {
		console.error('定时任务报错了：',error);
	}
}


async function deleteFilesBeforeYesterday() {
	console.log('定时任务开始--删除所有的文件');
	// 获取当前日期
	const now = new Date();
	const yesterday = new Date(now.getTime() - (24 * 60 * 60 * 1000 * 2));

	// 获取指定路径下的所有文件
	const files = fs.readdirSync(path);

	// 遍历所有文件
	for (const file of files) {
		/*// 获取文件的创建时间
		const stat = fs.statSync(path + "/" + file);

		// 如果文件的创建时间小于昨天，则删除
		if (stat.ctime < yesterday) {
			console.log('定时任务开始--删除的文件：',file);
			fs.unlinkSync(path + "/" + file);
		}*/

		// 遍历所有文件
		for (const file of files) {
			// 删除文件
			console.log('定时任务开始--删除的文件：',file);
			fs.unlinkSync("./uploads" + file);
		}
	}
}


async function checkTokenExpires() {
	console.log('定时任务开始--检查token是否快过期');
	//提前两天去检查更新
	const currentDatePlusTwoDay = getCurrentDatePlusTwoDay();
	for (let i = 0; i < accessTokens.length; i++) {
		const jwt = jwt_decode(accessTokens[i]) as JWT;
		if (jwt.exp) {
			const expirationTime = dayjs.unix(jwt.exp).format('YYYY-MM-DD');
			if (currentDatePlusTwoDay >= expirationTime) {
				const email = jwt["https://api.openai.com/profile"].email;
				console.log('准备过期了，email:',email,',过期时间:',dayjs.unix(jwt.exp).format('YYYY-MM-DD HH:mm:ss'));
				//console.log('userInfoMap:',...userInfoMap);
				//取出参数
				const userInfo = userInfoMap.get(email);
				if(userInfo){
					var accessToken;
					if(userInfo.type){
						console.log('[浏览器方式]准备登录获取token,username:',email);
						const resp = await postData(loginUrlOfMicros, userInfo);
						console.log('响应参数：',resp);
						if(!resp || resp.status!=='success'){
							console.error('[浏览器方式] 报错：',resp.message)
						}
						accessToken = resp.data;
					}else{
						//console.log('准备登录获取token,userInfo:',userInfo);
						const resp = await postData(loginUrl, userInfo);
						console.log('响应参数：',resp);
						accessToken = resp.accessToken;
					}
					if(accessToken){
						//替换配置文件的内容
						let openaiaccesstoken = process.env.OPENAI_ACCESS_TOKEN;
						process.env.OPENAI_ACCESS_TOKEN = openaiaccesstoken.replace(accessTokens[i],accessToken);
						console.log('更改后的OPENAI_ACCESS_TOKEN：',process.env.OPENAI_ACCESS_TOKEN);
						updateEnvFile('OPENAI_ACCESS_TOKEN',process.env.OPENAI_ACCESS_TOKEN);
						//清空ipCache
						ipCache.clear();
						//重新赋值
						setAccessTokens(parseKeys(process.env.OPENAI_ACCESS_TOKEN));
					}

				}
			}
		}
	}
	console.log('定时任务结束--检查token是否快过期');
}

function getCurrentDate(): string {
	return dayjs().format('YYYY-MM-DD');
}

function getCurrentDatePlusTwoDay(): string {
	const nextDay = dayjs().add(2, 'day');
	return nextDay.format('YYYY-MM-DD');
}

export async function postData(url: string, data: Record<string, any>) {
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});

		return await response.json();
	} catch (error) {
		console.error('Error:', error);
	}
}

function parseJsonString(jsonString: string): any {
	try {
		return JSON.parse(jsonString);
	} catch (error) {
		console.error('Error parsing JSON:', error);
		return null;
	}
}
