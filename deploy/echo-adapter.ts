/**
 * echo-llm-adapter — 实机测试夹具（生产环境请勿挂载）。
 *
 * 在没有 DEEPSEEK_API_KEY 的机器上，用它注册 provider `echo`，
 * 让 Harness 的真实 agent-loop / 会话 / 事件流完整跑通：模型把用户的
 * 最后一条消息原样回显，逐字流式输出。配合 dsh-remote-x 插件即可在
 * 远程主机上做端到端实机测试。
 *
 * 注册方式（见 deploy-remote.sh 生成的 cordis 补丁）：
 *   - insert:
 *       - id: echo-llm
 *         name: '<本文件绝对路径>'
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'echo-llm-adapter'

export const inject = ['llm']

class EchoAdapter extends LlmAdapter {
  providerInfo() {
    return { id: 'echo', name: 'Echo（测试适配器）' }
  }

  async listModels() {
    return [{ provider: 'echo', id: 'echo-1', name: 'Echo 回声模型' }]
  }

  // 声明模型支持的推理强度，否则 loop 会以 UNSUPPORTED_REASONING_EFFORT 拒绝请求
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: 'Echo 回声模型',
      reasoning: {
        efforts: [
          { id: 'max', name: '最高' },
          { id: 'high', name: '高' },
          { id: 'low', name: '低' },
        ],
      },
    }
  }

  async *stream(options) {
    const messages = options?.messages ?? []
    // 只回显真人输入（source.kind === 'user'），跳过 harness 注入的上下文消息
    const lastUser = [...messages].reverse().find(
      message => message.role === 'user' && message.source?.kind === 'user',
    )
    const prompt = (lastUser?.content ?? [])
      .map(block => (block?.type === 'text' ? block.text : ''))
      .join('')
    const reply = `（Echo 实机测试）已收到你的消息：${prompt}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (let index = 0; index < reply.length; index += 4) {
      yield { type: 'text-delta', index: 0, text: reply.slice(index, index + 4) }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['echo'], new EchoAdapter())
  ctx.logger.info('echo-llm-adapter: provider "echo" 已注册（实机测试夹具）')
}
