/** 写入主进程的密钥补丁（空字符串表示清除该项，改用 .env） */
export interface UserApiSettingsPatch {
  dashscopeApiKey?: string
  dashscopeModel?: string
  dashscopeModelChain?: string
  dashscopeChatCompletionsUrl?: string
  volcTtsApiKey?: string
  volcAccessKeyId?: string
  volcSecretAccessKey?: string
  pexelsApiKey?: string
  pixabayApiKey?: string
}

/** 返回给界面展示（仅前后片段，避免完整密钥外露） */
export interface UserApiSettingsPublic {
  /** 当前是否具备有效密钥（本机设置或 .env 合并后） */
  dashscopeConfigured: boolean
  /** 是否写入过 user-api-settings.json（可清除并回退 .env） */
  dashscopeSavedInSettings: boolean
  dashscopeApiKeyMasked: string
  dashscopeModel?: string
  dashscopeModelChain?: string
  dashscopeChatCompletionsUrl?: string
  volcTtsConfigured: boolean
  volcTtsSavedInSettings: boolean
  volcTtsApiKeyMasked: string
  volcIamConfigured: boolean
  volcIamSavedInSettings: boolean
  volcAccessKeyIdMasked: string
  volcSecretAccessKeyMasked: string
  pexelsConfigured: boolean
  pexelsSavedInSettings: boolean
  pexelsApiKeyMasked: string
  pixabayConfigured: boolean
  pixabaySavedInSettings: boolean
  pixabayApiKeyMasked: string
}
