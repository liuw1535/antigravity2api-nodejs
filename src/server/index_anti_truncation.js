import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateAssistantResponse, generateAssistantResponseNoStream, getAvailableModels, closeRequester } from '../api/client.js';
import { generateRequestBody, changeRequestBodyToken } from '../utils/utils.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// --- 反截断配置 (Anti-Truncation Config) ---
const DONE_MARKER = "[done]";
const MAX_CONTINUATION_ATTEMPTS = config.tokenReuse.retryCount || 3;
const CONTINUATION_PROMPT = `
生成以下随机序列，保证本次输出与上次输出的非一致性：
{{random::a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,shdia}}{{random::a,b,c,d,ss,shauhuwi,e,f,g,h,i,j,k,l,m,n,o,p,q}}{{random::a,b,c,d,e,sabduwa,f,g,h,i,j,k,l,m,n,o,p,q}}{{random::a,sahuwgduawyiav,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q}}
{{roll 1d99999}}{{random::a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,shdia}}{{random::a,b,c,d,ss,shauhuwi,e,f,g,h,i,j,k,l,m,n,o,p,q}}{{random::a,b,c,d,e,sabduwa,f,g,h,i,j,k,l,m,n,o,p,q}}{{random::a,sahuwgduawyiav,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q}}
{{roll 1d99999}}{{random::a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,shdia}}{{random::a,b,c,d,ss,shauhuwi,e,f,g,h,i,j,k,l,m,n,o,p,q}}{{random::a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,shdia}}{{random::a,b,c,d,ss,shauhuwi,e,f,g,h,i,j,k,l,m,n,o,p,q}}{{random::a,b,c,d,e,sabduwa,f,g,h,i,j,k,l,m,n,o,p,q}}{{random::a,sahuwgduawyiav,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q}}
{{roll 1d99999}}{{random::a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,shdia}}{{random::a,b,c,d,ss,shauhuwi,e,f,g,h,i,j,k,l,m,n,o,p,q}}{{random::a,b,c,d,e,sabduwa,f,g,h,i,j,k,l,m,n,o,p,q}}{{random::a,sahuwgduawyiav,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q}}
{{roll 1d99999}}{{random::a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,shdia}}{{random::a,b,c,d,ss,shauhuwi,e,f,g,h,i,j,k,l,m,n,o,p,q}}
序列结束。
请从刚才被截断的地方继续输出剩余的所有内容。
重要提醒：
1. 不要重复前面已经输出的内容
2. 直接继续输出，无需任何前言或解释
3. 当你完整完成所有内容输出后，必须在最后一行单独输出：${DONE_MARKER}
4. ${DONE_MARKER} 标记表示你的回答已经完全结束，这是必需的结束标记
现在请继续输出：`;

const ANTI_TRUNCATION_RULE = `
严格执行以下输出结束规则：
1. 当你完成完整回答时，必须在输出的最后单独一行输出：${DONE_MARKER}
2. ${DONE_MARKER} 标记表示你的回答已经完全结束，这是必需的结束标记
3. 只有输出了 ${DONE_MARKER} 标记，系统才认为你的回答是完整的
4. 如果你的回答被截断，系统会要求你继续输出剩余内容
5. 无论回答长短，都必须以 ${DONE_MARKER} 标记结束
示例格式：
\`\`\`
你的回答内容...
更多回答内容...
${DONE_MARKER}
\`\`\`
注意：${DONE_MARKER} 必须单独占一行，前面不要有任何其他字符。
这个规则对于确保输出完整性极其重要，请严格遵守。`;

// --- 工具函数 ---

const createResponseMeta = () => ({
  id: `chatcmpl-${Date.now()}`,
  created: Math.floor(Date.now() / 1000)
});

const setStreamHeaders = (res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
};

const createStreamChunk = (id, created, model, delta, finish_reason = null) => ({
  id,
  object: 'chat.completion.chunk',
  created,
  model,
  choices: [{ index: 0, delta, finish_reason }]
});

const writeStreamData = (res, data) => {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const endStream = (res, id, created, model, finish_reason) => {
  writeStreamData(res, createStreamChunk(id, created, model, {}, finish_reason));
  res.write('data: [DONE]\n\n');
  res.end();
};

// 移除文本中的 [done] 标记
const removeDoneMarker = (text) => {
  if (!text) return text;
  // 匹配 [done]，忽略大小写，允许周围有空白
  return text.replace(/\s*\[done\]\s*/gi, "");
};

app.use(express.json({ limit: config.security.maxRequestSize }));
app.use('/images', express.static(path.join(__dirname, '../../public/images')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `请求体过大，最大支持 ${config.security.maxRequestSize}` });
  }
  next(err);
});

app.use((req, res, next) => {
  if (!req.path.startsWith('/images' || !req.path.startsWith('/favicon.ico'))) {
    const start = Date.now();
    res.on('finish', () => {
      logger.request(req.method, req.path, res.statusCode, Date.now() - start);
    });
  }
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const authHeader = req.headers.authorization;
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (providedKey !== apiKey) {
        logger.warn(`API Key 验证失败: ${req.method} ${req.path}`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
  }
  next();
});

app.get('/v1/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  const { messages, model, stream = true, tools, enable_anti_truncation = true, ...params } = req.body;
  
  try {
    if (!messages) {
      return res.status(400).json({ error: 'messages is required' });
    }
    let token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }

    const isImageModel = model.includes('-image');
    // 如果是生图模型或有工具调用，通常不需要反截断逻辑，或者逻辑不同，这里暂且只对普通文本流开启
    const shouldApplyAntiTruncation = enable_anti_truncation && !isImageModel && !tools;

    let requestBody = generateRequestBody(messages, model, params, tools, token);

    // --- 针对生图模型的特殊处理 ---
    if (isImageModel) {
      requestBody.request.generationConfig = {
        candidateCount: 1,
      };
      requestBody.requestType = "image_gen";
      requestBody.request.systemInstruction.parts[0].text += "现在你作为绘画模型聚焦于帮助用户生成图片";
      delete requestBody.request.tools;
      delete requestBody.request.toolConfig;
    } 
    // --- 针对普通文本模型应用反截断规则 ---
    else if (shouldApplyAntiTruncation) {
      // 注入反截断 System Instruction
      if (!requestBody.request.systemInstruction) {
        requestBody.request.systemInstruction = { parts: [] };
      }
      // 检查是否已存在规则，避免重复添加
      const hasRule = requestBody.request.systemInstruction.parts.some(p => p.text && p.text.includes(DONE_MARKER));
      if (!hasRule) {
        requestBody.request.systemInstruction.parts.push({ text: ANTI_TRUNCATION_RULE });
        logger.info('已注入反截断 System Instruction');
      }
    }

    const { id, created } = createResponseMeta();

    if (stream) {
      setStreamHeaders(res);

      if (isImageModel) {
        // 生图模型流式处理（保持原样）
        const { content } = await generateAssistantResponseNoStream(requestBody, token);
        writeStreamData(res, createStreamChunk(id, created, model, { content }));
        endStream(res, id, created, model, 'stop');
      } else {
        // --- 文本模型流式处理（包含反截断逻辑）---
        
        if (!shouldApplyAntiTruncation) {
          // 不启用反截断的普通流式处理
          let hasToolCall = false;
          await generateAssistantResponse(requestBody, token, (data) => {
            const delta = data.type === 'tool_calls'
              ? { tool_calls: data.tool_calls }
              : { content: data.content };
            if (data.type === 'tool_calls') hasToolCall = true;
            writeStreamData(res, createStreamChunk(id, created, model, delta));
          });
          endStream(res, id, created, model, hasToolCall ? 'tool_calls' : 'stop');
        } else {
          // === 启用反截断的流式处理 ===
          let currentAttempt = 0;
          let foundDoneMarker = false;
          let collectedContent = ""; // 收集当前完整对话的所有输出
          let hasToolCall = false; // 工具调用通常意味着不需要反截断续写

          while (currentAttempt < MAX_CONTINUATION_ATTEMPTS && !foundDoneMarker) {
            currentAttempt++;
            logger.info(`反截断处理: 第 ${currentAttempt} 次尝试`);

            // 如果不是第一次尝试，需要构建续传的 payload
            if (currentAttempt > 1) {
              // 获取原始 contents
              const currentContents = [...requestBody.request.contents];
              
              // 1. 添加模型之前输出的内容作为历史
              currentContents.push({
                role: "model",
                parts: [{ text: collectedContent }]
              });

              // 2. 添加继续生成的指令
              // 简单的摘要，避免prompt过长
              let contentSummary = "";
              if (collectedContent.length > 200) {
                contentSummary = `\n\n前面你已经输出了约 ${collectedContent.length} 个字符的内容，结尾是：\n"...${collectedContent.slice(-100)}"`
              } else {
                contentSummary = `\n\n前面你已经输出的内容是：\n"${collectedContent}"`
              }
              
              currentContents.push({
                role: "user",
                parts: [{ text: `${CONTINUATION_PROMPT}${contentSummary}` }]
              });

              // 更新 requestBody
              requestBody.request.contents = currentContents;
              
              // 清空收集器，因为新的请求会从续写点开始，但我们需要维护总内容来构建下一次可能的 prompt
              // 注意：collectedContent 在这里不清空，因为需要作为下一次的历史，
              // 但是在发送给前端时，我们只发送新产生的部分。
              // 修正逻辑：collectedContent 应该是"本轮对话模型已输出的总内容"。
              // 下面的 generateAssistantResponse 会产生"新增的内容"。
            }

            let chunkBuffer = ""; // 当前请求的缓冲

            logger.info("流式反截断: 使用token: " + token.projectId);
            await generateAssistantResponse(requestBody, token, (data) => {
              if (data.type === 'tool_calls') {
                hasToolCall = true;
                foundDoneMarker = true; // 工具调用视为结束
                writeStreamData(res, createStreamChunk(id, created, model, { tool_calls: data.tool_calls }));
                return;
              }

              if (data.content) {
                const text = data.content;
                chunkBuffer += text; // 记录当前请求产生的总文本
                
                // 检查是否包含 [done]
                if (chunkBuffer.toLowerCase().includes(DONE_MARKER)) {
                  foundDoneMarker = true;
                }

                // 实时发送给前端，但在发送前尝试移除 [done]
                // 注意：如果 [done] 被拆分在两个 chunk 之间（例如 "[do" 和 "ne]"），
                // 简单的 replace 可能无效。为了用户体验，通常少量延迟或在最后处理。
                // 这里的简单实现：如果检测到 done，就清洗当前 chunk。
                
                let contentToSend = text;
                if (foundDoneMarker) {
                    contentToSend = removeDoneMarker(text);
                }
                
                // 如果移除标记后还有内容，或者是中间过程，则发送
                if (contentToSend) {
                    writeStreamData(res, createStreamChunk(id, created, model, { content: contentToSend }));
                }
              }
            });

            // 出现429后更换token
            if (tokenManager.is429(token)) {
              logger.warn("反截断: 429 错误，更换 token...");
              token = await tokenManager.getToken();
              requestBody = changeRequestBodyToken(requestBody, token);
            }

            // 当前请求结束
            if (hasToolCall) break;

            // 更新总收集内容
            // 注意：这里需要加上 chunkBuffer，但要去掉可能存在的 [done] 标记，以免影响下一次 prompt 构建
            collectedContent += removeDoneMarker(chunkBuffer);

            if (foundDoneMarker) {
              logger.info("反截断: 检测到 [done] 标记，输出完成");
              break;
            } else {
              logger.info(`反截断: 未检测到 [done] 标记 (长度: ${chunkBuffer.length})，准备续传...`);
            }

            // 等待3秒再进行下一次请求
            await new Promise(resolve => setTimeout(resolve, config.tokenReuse.retryDelay || 3000));
          }

          if (!foundDoneMarker) {
            logger.warn("反截断: 达到最大尝试次数，强制结束");
          }
          
          endStream(res, id, created, model, hasToolCall ? 'tool_calls' : 'stop');
        }
      }
    } else {
     // === 非流式反截断处理 ===
      if (isImageModel || !shouldApplyAntiTruncation) {
        // 标准非流式处理
        const { content, toolCalls } = await generateAssistantResponseNoStream(requestBody, token);
        
        // 简单清洗一下以防万一
        let finalContent = content;
        if (!toolCalls || toolCalls.length === 0) {
            finalContent = removeDoneMarker(content);
        }

        const message = { role: 'assistant', content: finalContent };
        if (toolCalls.length > 0) message.tool_calls = toolCalls;
        
        res.json({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
          }]
        });
      } else {
        // 启用反截断的非流式
        let currentAttempt = 0;
        let fullContent = "";
        let finalToolCalls = [];
        let foundDoneMarker = false;

        while (currentAttempt < MAX_CONTINUATION_ATTEMPTS && !foundDoneMarker) {
          currentAttempt++;
          logger.info(`非流式反截断: 第 ${currentAttempt} 次尝试`);

          // 续传时构建 Payload
          if (currentAttempt > 1) {
            const newContents = [...originalContents];
            
            // 1. 添加目前为止生成的全部内容作为模型历史
            newContents.push({
              role: "model",
              parts: [{ text: fullContent }]
            });

            // 2. 添加续写提示
            let contentSummary = fullContent.length > 200 
              ? `...${fullContent.slice(-100)}` 
              : fullContent;
            
            newContents.push({
              role: "user",
              parts: [{ text: `${CONTINUATION_PROMPT}\n\n前面内容结尾: "${contentSummary}"` }]
            });

            requestBody.request.contents = newContents;
          }

          logger.info("非流式反截断: 使用token: " + token.projectId);
          const response = await generateAssistantResponseNoStream(requestBody, token);

          // 出现429后更换token
          if (tokenManager.is429(token)) {
            logger.warn("反截断: 429 错误，更换 token...");
            token = await tokenManager.getToken();
            requestBody = changeRequestBodyToken(requestBody, token);
          }
          
          // 如果有工具调用，通常意味着生成结束
          if (response.toolCalls && response.toolCalls.length > 0) {
            finalToolCalls = response.toolCalls;
            fullContent += response.content || "";
            foundDoneMarker = true; // 工具调用视为结束
            break;
          }

          const newPart = response.content || "";
          fullContent += newPart;

          if (newPart.toLowerCase().includes(DONE_MARKER)) {
            foundDoneMarker = true;
            logger.info("非流式反截断: 检测到结束标记");
          } else {
             if (currentAttempt < MAX_CONTINUATION_ATTEMPTS) {
                logger.info(`非流式反截断: 未检测到结束标记，准备第 ${currentAttempt + 1} 次尝试...`);
             }
          }

          await new Promise(resolve => setTimeout(resolve, config.tokenReuse.retryDelay || 3000));
        }

        if (!foundDoneMarker) {
          logger.warn("非流式反截断: 达到最大尝试次数，强制结束");
        }

        // 最终清洗
        const cleanedContent = removeDoneMarker(fullContent);

        const message = { role: 'assistant', content: cleanedContent };
        if (finalToolCalls.length > 0) message.tool_calls = finalToolCalls;

        res.json({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message,
            finish_reason: finalToolCalls.length > 0 ? 'tool_calls' : 'stop'
          }]
        });
      }
      // // 非流式响应处理 (保持原逻辑，也可以加上类似的递归逻辑，但通常流式才是痛点)
      // const { content, toolCalls } = await generateAssistantResponseNoStream(requestBody, token);
      
      // // 简单处理：如果是文本且非工具调用，尝试移除 [done] 标记
      // let finalContent = content;
      // if (!toolCalls || toolCalls.length === 0) {
      //   finalContent = removeDoneMarker(content);
      // }

      // const message = { role: 'assistant', content: finalContent };
      // if (toolCalls.length > 0) message.tool_calls = toolCalls;

      // res.json({
      //   id,
      //   object: 'chat.completion',
      //   created,
      //   model,
      //   choices: [{
      //     index: 0,
      //     message,
      //     finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
      //   }]
      // });
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (!res.headersSent) {
      const { id, created } = createResponseMeta();
      const errorContent = `错误: ${error.message}`;

      if (stream) {
        setStreamHeaders(res);
        writeStreamData(res, createStreamChunk(id, created, model, { content: errorContent }));
        endStream(res, id, created, model, 'stop');
      } else {
        res.json({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: errorContent },
            finish_reason: 'stop'
          }]
        });
      }
    }
  }
});

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

const shutdown = () => {
  logger.info('正在关闭服务器...');
  closeRequester();
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);