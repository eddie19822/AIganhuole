/**
 * 豆包语音合成大模型音色（摘自火山引擎文档，随控制台更新可能增减）。
 * https://www.volcengine.com/docs/6561/1257544
 *
 * speaker 须与 VOLC_TTS_RESOURCE_ID（模型版本）匹配；2.0 多为 *_uranus_bigtts，1.0 常见 *_moon_bigtts / *_mars_bigtts / *_emo_* 等。
 */

export interface DoubaoVoiceEntry {
  speaker: string
  /** 展示名（含场景说明时写在括号） */
  name: string
}

export const DOUBAO_RESOURCE_PRESETS: {
  resourceId: string
  label: string
}[] = [
  {
    resourceId: 'seed-tts-1.0',
    label: '豆包语音合成 1.0（seed-tts-1.0）',
  },
  {
    resourceId: 'seed-tts-2.0',
    label: '豆包语音合成 2.0（seed-tts-2.0）',
  },
]

/** 适用于 seed-tts-1.0 */
export const DOUBAO_VOICES_SEED1: DoubaoVoiceEntry[] = [
  { speaker: 'zh_female_shuangkuaisisi_moon_bigtts', name: '爽快思思 / Skye' },
  { speaker: 'zh_female_qinqienvsheng_moon_bigtts', name: '亲切女声' },
  { speaker: 'zh_female_linjianvhai_moon_bigtts', name: '邻家女孩' },
  { speaker: 'zh_male_yuanboxiaoshu_moon_bigtts', name: '渊博小叔' },
  { speaker: 'zh_male_yangguangqingnian_moon_bigtts', name: '阳光青年' },
  { speaker: 'zh_female_tianmeixiaoyuan_moon_bigtts', name: '甜美小源' },
  { speaker: 'zh_female_qingchezizi_moon_bigtts', name: '清澈梓梓' },
  { speaker: 'zh_male_jieshuoxiaoming_moon_bigtts', name: '解说小明' },
  { speaker: 'zh_female_kailangjiejie_moon_bigtts', name: '开朗姐姐' },
  { speaker: 'zh_male_linjiananhai_moon_bigtts', name: '邻家男孩' },
  { speaker: 'zh_female_tianmeiyueyue_moon_bigtts', name: '甜美悦悦' },
  { speaker: 'zh_female_xinlingjitang_moon_bigtts', name: '心灵鸡汤' },
  { speaker: 'zh_male_wennuanahu_moon_bigtts', name: '温暖阿虎 / Alvin' },
  { speaker: 'zh_male_shaonianzixin_moon_bigtts', name: '少年梓辛 / Brayan' },
  { speaker: 'zh_male_yuzhouzixuan_moon_bigtts', name: '豫州子轩（河南口音）' },
  { speaker: 'zh_female_daimengchuanmei_moon_bigtts', name: '呆萌川妹' },
  { speaker: 'zh_male_guangxiyuanzhou_moon_bigtts', name: '广西远舟' },
  { speaker: 'zh_female_wanwanxiaohe_moon_bigtts', name: '弯弯小荷' },
  { speaker: 'zh_female_wanqudashu_moon_bigtts', name: '湾区大叔' },
  { speaker: 'zh_male_guozhoudege_moon_bigtts', name: '广州德哥' },
  { speaker: 'zh_male_haoyuxiaoge_moon_bigtts', name: '浩宇小哥（青岛口音）' },
  { speaker: 'zh_male_beijingxiaoye_moon_bigtts', name: '北京小爷' },
  { speaker: 'zh_male_jingqiangkanye_moon_bigtts', name: '京腔侃爷' },
  { speaker: 'zh_female_meituojieer_moon_bigtts', name: '妹坨洁儿（长沙口音）' },
  { speaker: 'zh_female_gaolengyujie_moon_bigtts', name: '高冷御姐' },
  { speaker: 'zh_male_aojiaobazong_moon_bigtts', name: '傲娇霸总' },
  { speaker: 'zh_female_meilinvyou_moon_bigtts', name: '魅力女友' },
  { speaker: 'zh_male_shenyeboke_moon_bigtts', name: '深夜播客' },
  { speaker: 'zh_female_sajiaonvyou_moon_bigtts', name: '撒娇女友' },
  { speaker: 'zh_female_yuanqinvyou_moon_bigtts', name: '元气女友' },
  { speaker: 'zh_male_dongfanghaoran_moon_bigtts', name: '东方浩然' },
  { speaker: 'zh_female_wenrouxiaoya_moon_bigtts', name: '温柔小雅' },
  { speaker: 'zh_female_roumeinvyou_emo_v2_mars_bigtts', name: '柔美女友（多情感）' },
  { speaker: 'zh_female_shuangkuaisisi_emo_v2_mars_bigtts', name: '爽快思思（多情感）' },
  { speaker: 'zh_male_yangguangqingnian_emo_v2_mars_bigtts', name: '阳光青年（多情感）' },
  { speaker: 'zh_male_lengkugege_emo_v2_mars_bigtts', name: '冷酷哥哥（多情感）' },
  { speaker: 'zh_female_gaolengyujie_emo_v2_mars_bigtts', name: '高冷御姐（多情感）' },
  { speaker: 'zh_male_ruyayichen_emo_v2_mars_bigtts', name: '儒雅男友（多情感）' },
  { speaker: 'zh_female_yingyujiaoyu_mars_bigtts', name: 'Tina 老师' },
]

/** 适用于 seed-tts-2.0 */
export const DOUBAO_VOICES_SEED2: DoubaoVoiceEntry[] = [
  { speaker: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0' },
  { speaker: 'zh_female_xiaohe_uranus_bigtts', name: '小何 2.0' },
  { speaker: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0' },
  { speaker: 'zh_male_taocheng_uranus_bigtts', name: '小天 2.0' },
  { speaker: 'zh_male_liufei_uranus_bigtts', name: '刘飞 2.0' },
  { speaker: 'zh_male_sophie_uranus_bigtts', name: '魅力苏菲 2.0' },
  { speaker: 'zh_female_qingxinnvsheng_uranus_bigtts', name: '清新女声 2.0' },
  { speaker: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 2.0' },
  { speaker: 'zh_female_sajiaoxuemei_uranus_bigtts', name: '撒娇学妹 2.0' },
  { speaker: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源 2.0' },
  { speaker: 'zh_female_tianmeitaozi_uranus_bigtts', name: '甜美桃子 2.0' },
  { speaker: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思 2.0' },
  { speaker: 'zh_female_peiqi_uranus_bigtts', name: '佩奇猪 2.0' },
  { speaker: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩 2.0' },
  { speaker: 'zh_male_shaonianzixin_uranus_bigtts', name: '少年梓辛 / Brayan 2.0' },
  { speaker: 'zh_male_sunwukong_uranus_bigtts', name: '猴哥 2.0' },
  { speaker: 'zh_female_yingyujiaoxue_uranus_bigtts', name: 'Tina 老师 2.0' },
  { speaker: 'zh_female_kefunvsheng_uranus_bigtts', name: '暖阳女声 2.0' },
  { speaker: 'zh_female_xiaoxue_uranus_bigtts', name: '儿童绘本 2.0' },
  { speaker: 'zh_male_dayi_uranus_bigtts', name: '大壹 2.0' },
  { speaker: 'zh_female_mizai_uranus_bigtts', name: '黑猫侦探社咪仔 2.0' },
  { speaker: 'zh_female_jitangnv_uranus_bigtts', name: '鸡汤女 2.0' },
  { speaker: 'zh_female_meilinvyou_uranus_bigtts', name: '魅力女友 2.0' },
  { speaker: 'zh_female_liuchangnv_uranus_bigtts', name: '流畅女声 2.0' },
  { speaker: 'zh_male_ruyayichen_uranus_bigtts', name: '儒雅逸辰 2.0' },
  { speaker: 'en_male_tim_uranus_bigtts', name: 'Tim（美式英语）' },
  { speaker: 'en_female_dacey_uranus_bigtts', name: 'Dacey（美式英语）' },
]

export function voicesForResourceId(resourceId: string): DoubaoVoiceEntry[] {
  const id = resourceId.trim().toLowerCase()
  if (id === 'seed-tts-2.0') return DOUBAO_VOICES_SEED2
  return DOUBAO_VOICES_SEED1
}
