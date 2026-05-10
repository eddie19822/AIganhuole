/**
 * Turn segment text into English-ish stock keywords for Pexels.
 * Without a translation API: dictionary hints + any Latin words in the text.
 */

const HINTS: [string, string][] = [
  ['咖啡店', 'coffee shop cafe'],
  ['咖啡馆', 'coffee shop cafe'],
  ['办公室', 'office workplace'],
  ['写字楼', 'office building city'],
  ['地铁站', 'subway metro station'],
  ['火车站', 'train station'],
  ['机场', 'airport'],
  ['高速公路', 'highway road'],
  ['大海', 'ocean sea waves'],
  ['沙滩', 'beach sand coast'],
  ['沙漠', 'desert sand dunes'],
  ['雪山', 'snow mountain alpine'],
  ['森林', 'forest trees woodland'],
  ['草原', 'grassland meadow prairie'],
  ['湖泊', 'lake water reflection'],
  ['河流', 'river flowing water'],
  ['瀑布', 'waterfall'],
  ['下雨', 'rain rainy street'],
  ['雨天', 'rain umbrella city'],
  ['夜晚', 'night city lights'],
  ['夜景', 'night city skyline'],
  ['黄昏', 'sunset golden hour'],
  ['日出', 'sunrise dawn horizon'],
  ['阳光', 'sunlight bright nature'],
  ['月光', 'moon night sky'],
  ['星空', 'stars night sky milky way'],
  ['婚礼', 'wedding ceremony couple'],
  ['家庭', 'family home warm'],
  ['孩子', 'children kids playing'],
  ['婴儿', 'baby newborn tender'],
  ['老人', 'elderly person portrait'],
  ['跑步', 'running jogging fitness'],
  ['瑜伽', 'yoga calm wellness'],
  ['健身', 'gym fitness workout'],
  ['舞蹈', 'dance dancing performance'],
  ['音乐', 'music concert instruments'],
  ['钢琴', 'piano hands playing'],
  ['吉他', 'guitar musician'],
  ['猫', 'cat pet adorable'],
  ['狗', 'dog pet walking'],
  ['鸟', 'birds flying sky'],
  ['鱼', 'fish underwater ocean'],
  ['花', 'flowers bloom garden'],
  ['樱花', 'cherry blossom spring'],
  ['稻田', 'rice field countryside'],
  ['农田', 'farmland countryside'],
  ['村庄', 'village countryside'],
  ['古镇', 'ancient town alley'],
  ['城市', 'city skyline urban'],
  ['街道', 'street pedestrian city'],
  ['车流', 'traffic cars city night'],
  ['地铁', 'subway metro underground'],
  ['自行车', 'bicycle cycling street'],
  ['火车', 'train travel journey'],
  ['飞机', 'airplane airport travel'],
  ['船', 'boat ship sailing'],
  ['滑雪', 'skiing snow winter'],
  ['冲浪', 'surfing ocean waves'],
  ['潜水', 'diving underwater coral'],
  ['爬山', 'hiking mountain trail'],
  ['露营', 'camping tent outdoors'],
  ['篝火', 'campfire night outdoors'],
  ['图书馆', 'library books quiet'],
  ['教室', 'classroom students learning'],
  ['医院', 'hospital healthcare'],
  ['厨房', 'kitchen cooking food'],
  ['餐厅', 'restaurant dining food'],
  ['书店', 'bookstore books reading'],
  ['美术馆', 'art gallery museum'],
  ['寺庙', 'temple architecture peaceful'],
  ['教堂', 'church architecture'],
  ['桥梁', 'bridge river architecture'],
  ['隧道', 'tunnel light cinematic'],
  ['烟花', 'fireworks celebration night'],
  ['蜡烛', 'candle warm romantic'],
  ['拥抱', 'hug couple emotional'],
  ['告别', 'farewell train station emotional'],
  ['回忆', 'nostalgia memories cinematic'],
  ['梦境', 'dream surreal soft focus'],
  ['孤独', 'lonely solitary silhouette'],
  ['希望', 'hope sunrise hands'],
  ['恐惧', 'fear dark corridor tension'],
  ['爱情', 'love couple romantic'],
  ['友情', 'friends laughing together'],
  ['战争', 'war documentary tension'],
  ['科技', 'technology futuristic digital'],
  ['人工智能', 'artificial intelligence abstract'],
  ['电脑', 'computer typing office'],
  ['手机', 'smartphone hands close up'],
  ['镜头', 'camera lens filmmaker'],
  ['电影感', 'cinematic mood atmospheric'],
]

const SORTED = [...HINTS].sort((a, b) => b[0].length - a[0].length)

export function suggestStockSearchQuery(segment: string): string {
  let remaining = segment
  const terms: string[] = []

  for (const [cn, en] of SORTED) {
    if (remaining.includes(cn)) {
      terms.push(...en.split(/\s+/).filter(Boolean))
      remaining = remaining.split(cn).join(' ')
    }
  }

  const latin = segment.match(/[a-zA-Z][a-zA-Z\s-]{2,}/g)
  if (latin) {
    for (const chunk of latin) {
      const words = chunk
        .trim()
        .split(/\s+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length >= 3)
      terms.push(...words)
    }
  }

  const uniq = [...new Set(terms)]
  const joined = uniq.slice(0, 8).join(' ')
  if (joined.length >= 6) return joined.slice(0, 120)

  return 'cinematic storytelling mood atmospheric'
}
