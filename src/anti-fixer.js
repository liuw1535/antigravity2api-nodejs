// File: transformers/anti-fixer.js
//
// Ensures Gemini-compatible function calls include the required `thought_signature`
// to prevent INVALID_ARGUMENT errors from the anti-ai provider.

class AntiPayloadFixer {
  constructor(options, logger) {
    this.name = "anti-payload-fixer";
    this.log = logger || console.log;
    // Per-function-call signature cache: callKey -> { signature, timestamp }
    // callKey is based on hash(function_name + JSON.stringify(args))
    this.signatureCache = new Map();
  }

  // Generate a unique cache key for a specific function call based on name + args
  generateCallKey(functionName, args, id = null) {
    if (id) return `id:${id}`;
    if (!functionName) return null;
    const argsStr = typeof args === 'string' ? args : JSON.stringify(args || {});
    // Simple hash: use first 16 chars of base64 encoded string
    const combined = `${functionName}:${argsStr}`;
    const hash = Buffer.from(combined).toString('base64').substring(0, 24);
    return `call:${functionName}:${hash}`;
  }

  // Generate key from a tool_call object (OpenAI format)
  generateCallKeyFromToolCall(tc) {
    const name = tc.function?.name || tc.name;
    const args = tc.function?.arguments || tc.args;
    return this.generateCallKey(name, args, tc.id);
  }

  transformRequestIn(request, provider) {
    this.log(
      "[AntiPayloadFixer] Transforming for provider:",
      provider?.name,
      "Before:",
      JSON.stringify(request, null, 2)
    );

    // Defensive copy so we don't mutate upstream payloads.
    const newReq = JSON.parse(JSON.stringify(request || {}));

    let added = 0;
    let missingBefore = 0;

    const ensureSignature = (fnObj, sigSeed, forcedSignature, callKey) => {
      if (!fnObj || typeof fnObj !== "object") return;

      if (forcedSignature) {
        fnObj.thought_signature = forcedSignature;
      } else if (!fnObj.thought_signature) {
        // Try cache first using per-call key
        if (callKey && this.signatureCache.has(callKey)) {
          const entry = this.signatureCache.get(callKey);
          fnObj.thought_signature = entry.signature;
          this.log(`[AntiPayloadFixer] Restored cached signature for ${callKey}`);
          missingBefore += 1;
          return;
        }

        // IMPORTANT: Do NOT generate fake signatures!
        // Per Gemini spec, only the FIRST functionCall in a turn has a signature.
        // Subsequent calls should have NO signature, not a fake one.
        this.log(`[AntiPayloadFixer] No signature found for ${callKey || sigSeed} - leaving empty (per Gemini spec)`);
      } else {
        missingBefore += 1;
      }
      // Note: Only thought_signature is needed. antigravity2api will read it and
      // place it at the part level as thoughtSignature for Gemini Native API.
    };

    // OpenAI-style messages
    if (Array.isArray(newReq.messages)) {
      const flattened = [];
      newReq.messages.forEach((msg, msgIdx) => {
        // Split multiple tool_calls into separate assistant messages to guarantee per-call signature propagation.
        if (
          msg.role === "assistant" &&
          Array.isArray(msg.tool_calls) &&
          msg.tool_calls.length > 1
        ) {
          msg.tool_calls.forEach((tc, tcIdx) => {
            const cloned = JSON.parse(JSON.stringify(msg));
            cloned.tool_calls = [tc];
            // Only use cache-based real signatures, no fake generation
            const callKey = this.generateCallKeyFromToolCall(tc);
            ensureSignature(tc.function, `${msgIdx}-${tcIdx}`, null, callKey);
            flattened.push(cloned);
          });
          return;
        }

        // Single tool_call or none
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          // Only use cache-based real signatures, no fake generation
          msg.tool_calls.forEach((tc, tcIdx) => {
            const callKey = this.generateCallKeyFromToolCall(tc);
            ensureSignature(tc.function, `${msgIdx}-${tcIdx}`, null, callKey);
          });
        }

        // legacy function_call
        if (msg.function_call) {
          ensureSignature(msg.function_call, `${msgIdx}-fc`);
        }

        // content parts that may contain functionCall/function_call (Gemini style)
        if (Array.isArray(msg.content)) {
          msg.content.forEach((part, partIdx) => {
            if (part?.functionCall) {
              ensureSignature(part.functionCall, `${msgIdx}-${partIdx}-pc`);
            }
            if (part?.function_call) {
              ensureSignature(part.function_call, `${msgIdx}-${partIdx}-pc`);
            }
          });
        }

        flattened.push(msg);
      });
      newReq.messages = flattened;
    }

    // Gemini-style contents
    if (Array.isArray(newReq.contents)) {
      newReq.contents.forEach((contentObj, cIdx) => {
        if (Array.isArray(contentObj.parts)) {
          contentObj.parts.forEach((part, pIdx) => {
            if (part?.functionCall) {
              ensureSignature(part.functionCall, `${cIdx}-${pIdx}-g`);
            }
            if (part?.function_call) {
              ensureSignature(part.function_call, `${cIdx}-${pIdx}-g`);
            }
          });
        }
      });
    }

    this.log(
      "[AntiPayloadFixer] After transformation:",
      JSON.stringify(newReq, null, 2)
    );
    this.log(
      `[AntiPayloadFixer] thought_signature stats — added: ${added}, pre-existing: ${missingBefore}`
    );
    // DEBUG LOGGING START
    if (newReq.messages && newReq.messages.length > 0) {
      newReq.messages.forEach((m, i) => {
        if (m.tool_calls) {
          m.tool_calls.forEach((tc, j) => {
            this.log(`[AntiPayloadFixer] OUTGOING MSG[${i}] TOOL_CALL[${j}] id: ${tc.id} thought_signature:`, tc.function?.thought_signature);
          });
        }
      });
    }
    // DEBUG LOGGING END
    return newReq;
  }

  async transformResponseOut(response) {
    this.log('[AntiPayloadFixer] transformResponseOut START');
    const contentType = response.headers.get("content-type") || "";
    const isEventStream = contentType.includes("text/event-stream");
    this.log('[AntiPayloadFixer] contentType:', contentType, 'isEventStream:', isEventStream, 'hasBody:', !!response.body);

    // For streaming responses, buffer and re-emit to fix compatibility issues
    if (response.body && isEventStream) {
      this.log('[AntiPayloadFixer] Starting to read stream...');
      const reader = response.body.getReader();
      const chunks = [];

      // Read all chunks
      let chunkCount = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          this.log('[AntiPayloadFixer] Stream reading DONE, total chunks:', chunkCount);
          break;
        }
        chunkCount++;
        chunks.push(value);
        this.log('[AntiPayloadFixer] Read chunk', chunkCount, 'size:', value?.length);

        // Also capture signatures from tool calls
        this.processChunkForSignatures(value);
      }

      this.log('[AntiPayloadFixer] Creating new ReadableStream with', chunks.length, 'chunks');
      // Create a new ReadableStream from buffered chunks using pull-based approach
      let chunkIndex = 0;
      const newStream = new ReadableStream({
        pull(controller) {
          if (chunkIndex < chunks.length) {
            controller.enqueue(chunks[chunkIndex]);
            chunkIndex++;
          } else {
            controller.close();
          }
        }
      });

      this.log('[AntiPayloadFixer] Returning new Response');
      return new Response(newStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    this.log('[AntiPayloadFixer] Returning original response (non-stream)');
    return response;
  }

  processChunkForSignatures(chunk) {
    try {
      const text = new TextDecoder().decode(chunk);
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.choices?.[0]?.delta?.tool_calls) {
              const toolCalls = parsed.choices[0].delta.tool_calls;
              toolCalls.forEach(tc => {
                if (tc.function && (tc.function.thought_signature || tc.function.thoughtSignature)) {
                  const sig = tc.function.thought_signature || tc.function.thoughtSignature;
                  const callKey = this.generateCallKeyFromStreamCall(tc);
                  if (callKey) {
                    this.signatureCache.set(callKey, { signature: sig, timestamp: Date.now() });
                  }
                }
              });
            }
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
  }

  async captureSignaturesFromStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const chunk = JSON.parse(data);
              // Log all parsed chunks to see what we're receiving
              if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
                const delta = chunk.choices[0].delta;
                if (delta.tool_calls) {
                  this.log(`[AntiPayloadFixer] STREAM: Found tool_calls in delta:`, JSON.stringify(delta.tool_calls));
                  const toolCalls = delta.tool_calls;
                  toolCalls.forEach(tc => {
                    this.log(`[AntiPayloadFixer] STREAM: Processing tool_call:`, JSON.stringify(tc));
                    if (tc.function && (tc.function.thought_signature || tc.function.thoughtSignature)) {
                      const sig = tc.function.thought_signature || tc.function.thoughtSignature;
                      // Cache by unique call key (based on function name + args)
                      const callKey = this.generateCallKeyFromStreamCall(tc);
                      this.log(`[AntiPayloadFixer] STREAM: Generated callKey=${callKey} for signature`);
                      if (callKey) {
                        this.log(`[AntiPayloadFixer] CACHING signature for ${callKey}: ${sig.substring(0, 20)}...`);
                        this.signatureCache.set(callKey, { signature: sig, timestamp: Date.now() });
                        this.log(`[AntiPayloadFixer] CACHE SIZE: ${this.signatureCache.size}`);
                      }
                    } else {
                      this.log(`[AntiPayloadFixer] STREAM: No signature in this tool_call`);
                    }
                  });
                }
              }
            } catch (e) {
              // ignore parse errors
            }
          }
        }
      }
    } catch (err) {
      this.log("[AntiPayloadFixer] Error interpreting stream:", err);
    }
  }

  // Helper for stream parsing - generate call key from stream tool call
  generateCallKeyFromStreamCall(tc) {
    const name = tc.function?.name || tc.name;
    const args = tc.function?.arguments || tc.args;
    return this.generateCallKey(name, args, tc.id);
  }
}

module.exports = AntiPayloadFixer;
