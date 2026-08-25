/**
 * GLOBAL knowledge seed (tenant_id NULL) — the spec §74 journey:
 *   Better Sleep → Sleep Hygiene → educational article → Magnesium → products.
 *
 * Deliberately TWO brands so brand neutrality is provable: adding the second
 * one is rows, not a schema change (spec §31), and nothing downstream ranks or
 * branches on a specific brand.
 *
 * One article here is not part of that journey and carries no topics or
 * ingredients: `how-a-stairstep-plan-pays` explains how the compensation family
 * most tenants operate under actually works (docs/70). It is knowledge a member
 * asks for on day one and nowhere else answers, so it is seeded as an ARTICLE —
 * platform reference — rather than as training, which docs/67 §2 deliberately
 * leaves for the tenant to write. It names a plan as a worked example and sets
 * no threshold anywhere in the engine; docs/62 §2 is why that distinction is
 * load-bearing rather than pedantic.
 */
/** Per-locale overrides; the base English fields are the fallback. */
export type Translations = Record<
  string,
  {
    name?: string;
    summary?: string;
    title?: string;
    description?: string;
    body?: string;
    safetyNotes?: string;
  }
>;

export interface KnowledgeSeed {
  healthGoals: Array<{
    code: string;
    name: string;
    description: string;
    order: number;
    translations?: Translations;
  }>;
  topics: Array<{
    code: string;
    name: string;
    summary: string;
    goals: string[];
    translations?: Translations;
  }>;
  ingredients: Array<{
    code: string;
    name: string;
    summary: string;
    safetyNotes: string;
    topics: string[];
    translations?: Translations;
  }>;
  articles: Array<{
    slug: string;
    title: string;
    summary: string;
    body: string;
    topics: string[];
    ingredients: string[];
    translations?: Translations;
  }>;
  evidence: Array<{
    ingredient: string;
    title: string;
    source: string;
    url: string;
    summary: string;
  }>;
  brands: Array<{ code: string; name: string }>;
  products: Array<{
    code: string;
    brand: string;
    name: string;
    description: string;
    sourceUrl: string;
    safetyNotes: string;
    ingredients: string[];
  }>;
}

export const KNOWLEDGE_SEED: KnowledgeSeed = {
  healthGoals: [
    {
      code: 'better-sleep',
      name: 'Better Sleep',
      description: 'Fall asleep more easily and wake up rested.',
      order: 1,
      translations: {
        th: {
          name: 'นอนหลับดีขึ้น',
          description: 'หลับง่ายขึ้นและตื่นมาสดชื่น',
        },
      },
    },
    {
      code: 'daily-energy',
      name: 'Daily Energy',
      description: 'Steadier energy through the day without relying on stimulants.',
      order: 2,
      translations: {
        th: {
          name: 'พลังงานระหว่างวัน',
          description: 'มีพลังงานสม่ำเสมอตลอดวันโดยไม่ต้องพึ่งสารกระตุ้น',
        },
      },
    },
    // Goals 3–10 come from Amway Thailand's own `solutions` taxonomy (docs/74
    // §5). Reusing a taxonomy a catalogue already publishes is what makes an
    // ingested product reachable: the sender does not have to guess which goal
    // AVIORA meant, because the goal was named from what the sender already says.
    {
      code: 'daily-nutrition',
      name: 'Daily Nutrition',
      description: 'Cover the everyday gaps in an ordinary diet.',
      order: 3,
      translations: {
        th: {
          name: 'โภชนาการประจำวัน',
          description: 'เติมช่องว่างสารอาหารที่มื้ออาหารปกติมักขาด',
        },
      },
    },
    {
      code: 'weight-management',
      name: 'Weight Management',
      description: 'Manage weight through what you eat and how you move.',
      order: 4,
      translations: {
        th: {
          name: 'การควบคุมน้ำหนัก',
          description: 'ดูแลน้ำหนักด้วยสิ่งที่กินและการเคลื่อนไหวในแต่ละวัน',
        },
      },
    },
    {
      code: 'heart-health',
      name: 'Heart Health',
      description: 'Look after the heart and circulation.',
      order: 5,
      translations: {
        th: {
          name: 'สุขภาพหัวใจ',
          description: 'ดูแลหัวใจและระบบไหลเวียนเลือด',
        },
      },
    },
    {
      code: 'immunity',
      name: 'Immunity',
      description: "Support the body's ordinary defences.",
      order: 6,
      translations: {
        th: {
          name: 'ภูมิคุ้มกัน',
          description: 'ดูแลกลไกป้องกันตามปกติของร่างกาย',
        },
      },
    },
    {
      code: 'gut-health',
      name: 'Gut & Liver Health',
      description: 'Digestion, regularity, and how the liver processes what we eat.',
      order: 7,
      translations: {
        th: {
          name: 'สุขภาพทางเดินอาหารและตับ',
          description: 'การย่อย การขับถ่าย และการทำงานของตับต่อสิ่งที่เรากิน',
        },
      },
    },
    {
      code: 'sport-nutrition',
      name: 'Sport Nutrition',
      description: 'Eating around training and recovery.',
      order: 8,
      translations: {
        th: {
          name: 'โภชนาการการกีฬา',
          description: 'การกินรอบการฝึกซ้อมและการฟื้นตัว',
        },
      },
    },
    {
      code: 'bone-health',
      name: 'Bone Health',
      description: 'Keep bones and joints strong as the years pass.',
      order: 9,
      translations: {
        th: {
          name: 'สุขภาพกระดูก',
          description: 'ดูแลกระดูกและข้อต่อให้แข็งแรงเมื่ออายุมากขึ้น',
        },
      },
    },
    {
      code: 'beauty-from-within',
      name: 'Beauty From Within',
      description: 'How nutrition shows up in skin and hair.',
      order: 10,
      translations: {
        th: {
          name: 'ความงามจากภายใน',
          description: 'โภชนาการส่งผลต่อผิวและเส้นผมอย่างไร',
        },
      },
    },
    // Goals 11–17 cover what a wellness catalogue sells besides supplements:
    // skin, hair, teeth, the body, and the water, air and surfaces of a home.
    // They come from Amway's own `solutions` taxonomy and its shop categories,
    // for the same reason the health goals did — a goal named from what the
    // catalogue already says is one the catalogue can be mapped onto.
    {
      code: 'skin-care',
      name: 'Skin Care',
      description: 'Look after skin day to day, and know what a routine can and cannot do.',
      order: 11,
      translations: {
        th: {
          name: 'การดูแลผิว',
          description: 'ดูแลผิวในแต่ละวัน และเข้าใจว่ากิจวัตรทำอะไรได้และทำอะไรไม่ได้',
        },
      },
    },
    {
      code: 'hair-care',
      name: 'Hair Care',
      description: 'Hair and scalp, and what actually changes them.',
      order: 12,
      translations: {
        th: {
          name: 'การดูแลเส้นผม',
          description: 'เส้นผมและหนังศีรษะ และสิ่งที่เปลี่ยนมันได้จริง',
        },
      },
    },
    {
      code: 'oral-care',
      name: 'Oral Care',
      description: 'Teeth and gums, and the small daily habits that decide them.',
      order: 13,
      translations: {
        th: {
          name: 'การดูแลช่องปาก',
          description: 'ฟันและเหงือก กับนิสัยเล็ก ๆ ประจำวันที่เป็นตัวตัดสิน',
        },
      },
    },
    {
      code: 'body-care',
      name: 'Body Care',
      description: 'Skin below the neck — washing, moisture, and hands that work.',
      order: 14,
      translations: {
        th: {
          name: 'การดูแลร่างกาย',
          description: 'ผิวตั้งแต่คอลงมา การทำความสะอาด ความชุ่มชื้น และมือที่ใช้งานหนัก',
        },
      },
    },
    {
      code: 'clean-water',
      name: 'Clean Water at Home',
      description: 'What is in tap water, and what treating it does.',
      order: 15,
      translations: {
        th: {
          name: 'น้ำสะอาดในบ้าน',
          description: 'ในน้ำประปามีอะไร และการกรองน้ำทำอะไรได้บ้าง',
        },
      },
    },
    {
      code: 'clean-air',
      name: 'Clean Air at Home',
      description: 'Indoor air, the particles in it, and how it is filtered.',
      order: 16,
      translations: {
        th: {
          name: 'อากาศสะอาดในบ้าน',
          description: 'อากาศในบ้าน อนุภาคที่อยู่ในนั้น และการกรองทำงานอย่างไร',
        },
      },
    },
    {
      code: 'a-cleaner-home',
      name: 'A Cleaner Home',
      description: 'Cleaning, cookware and food handling in an ordinary kitchen.',
      order: 17,
      translations: {
        th: {
          name: 'บ้านที่สะอาดขึ้น',
          description: 'การทำความสะอาด เครื่องครัว และการจัดการอาหารในครัวธรรมดา',
        },
      },
    },
  ],
  topics: [
    {
      code: 'sleep-hygiene',
      name: 'Sleep Hygiene',
      summary: 'The daily habits and environment that make good sleep likely.',
      goals: ['better-sleep'],
      translations: {
        th: {
          name: 'สุขอนามัยการนอน',
          summary: 'นิสัยประจำวันและสภาพแวดล้อมที่ทำให้การนอนหลับมีคุณภาพ',
        },
      },
    },
    {
      code: 'evening-nutrition',
      name: 'Evening Nutrition',
      summary: 'How the timing and content of evening meals affects sleep quality.',
      goals: ['better-sleep', 'daily-energy'],
      translations: {
        th: {
          name: 'โภชนาการมื้อเย็น',
          summary: 'เวลาและสิ่งที่กินในมื้อเย็นส่งผลต่อคุณภาพการนอนอย่างไร',
        },
      },
    },
    // One topic per new goal. A topic is where an ingredient attaches, so a goal
    // without one is a goal that leads nowhere — products hang off ingredients,
    // ingredients off topics, topics off goals, and a gap anywhere breaks the
    // whole chain (docs/74 §5).
    {
      code: 'nutrient-gaps',
      name: 'Nutrient Gaps',
      summary:
        'The nutrients an ordinary diet most often falls short on, and the foods they come from.',
      goals: ['daily-nutrition'],
      translations: {
        th: {
          name: 'ช่องว่างสารอาหาร',
          summary: 'สารอาหารที่มื้ออาหารทั่วไปมักได้ไม่พอ และอาหารที่เป็นแหล่งของมัน',
        },
      },
    },
    {
      code: 'energy-balance',
      name: 'Energy Balance',
      summary: 'Calories in and out, appetite, and why steady habits beat short efforts.',
      goals: ['weight-management', 'daily-energy'],
      translations: {
        th: {
          name: 'สมดุลพลังงาน',
          summary: 'พลังงานเข้าและออก ความอยากอาหาร และทำไมความสม่ำเสมอชนะการหักโหมระยะสั้น',
        },
      },
    },
    {
      code: 'heart-and-circulation',
      name: 'Heart & Circulation',
      summary: 'Diet, movement and the everyday numbers a doctor looks at.',
      goals: ['heart-health'],
      translations: {
        th: {
          name: 'หัวใจและการไหลเวียนเลือด',
          summary: 'อาหาร การเคลื่อนไหว และค่าที่แพทย์ดูเป็นประจำ',
        },
      },
    },
    {
      code: 'immune-support',
      name: 'Immune Support',
      summary: 'Sleep, food and the nutrients most discussed alongside normal immune function.',
      goals: ['immunity'],
      translations: {
        th: {
          name: 'การดูแลภูมิคุ้มกัน',
          summary: 'การนอน อาหาร และสารอาหารที่มักถูกพูดถึงคู่กับการทำงานปกติของภูมิคุ้มกัน',
        },
      },
    },
    {
      code: 'digestion-and-liver',
      name: 'Digestion & Liver',
      summary: 'Regularity, fibre, fermented foods, and how the liver handles what arrives.',
      goals: ['gut-health'],
      translations: {
        th: {
          name: 'การย่อยและตับ',
          summary: 'การขับถ่าย ใยอาหาร อาหารหมัก และการทำงานของตับต่อสิ่งที่รับเข้ามา',
        },
      },
    },
    {
      code: 'training-nutrition',
      name: 'Training Nutrition',
      summary: 'What to eat around exercise, and what recovery actually needs.',
      goals: ['sport-nutrition'],
      translations: {
        th: {
          name: 'โภชนาการรอบการฝึกซ้อม',
          summary: 'กินอะไรรอบการออกกำลังกาย และการฟื้นตัวต้องการอะไรจริง ๆ',
        },
      },
    },
    {
      code: 'bone-and-joint',
      name: 'Bones & Joints',
      summary: 'Load-bearing movement, and the minerals bone is built from.',
      goals: ['bone-health'],
      translations: {
        th: {
          name: 'กระดูกและข้อ',
          summary: 'การเคลื่อนไหวที่มีแรงกระทำ และแร่ธาตุที่เป็นโครงสร้างของกระดูก',
        },
      },
    },
    {
      code: 'skin-from-within',
      name: 'Skin From Within',
      summary: 'What diet does and does not do for skin and hair.',
      goals: ['beauty-from-within'],
      translations: {
        th: {
          name: 'ผิวและผมจากภายใน',
          summary: 'อาหารทำอะไรได้และทำอะไรไม่ได้กับผิวและเส้นผม',
        },
      },
    },
    // Topics for those goals. These are where a product with NO ingredient
    // attaches (docs/74 §6): a water filter belongs to `water-at-home`, not to
    // any substance, and until product↔topic existed it belonged nowhere a
    // member could find it.
    {
      code: 'skin-routine',
      name: 'Everyday Skin Routine',
      summary: 'Cleansing, moisture and sun — the three steps every routine is built on.',
      goals: ['skin-care', 'beauty-from-within'],
      translations: {
        th: {
          name: 'กิจวัตรดูแลผิวประจำวัน',
          summary: 'ทำความสะอาด ให้ความชุ่มชื้น และกันแดด สามขั้นที่ทุกกิจวัตรตั้งอยู่บนนี้',
        },
      },
    },
    {
      code: 'skin-concerns',
      name: 'Common Skin Concerns',
      summary: 'Dryness, oiliness, blemishes and uneven tone, and what each responds to.',
      goals: ['skin-care'],
      translations: {
        th: {
          name: 'ปัญหาผิวที่พบบ่อย',
          summary: 'ผิวแห้ง ผิวมัน สิว และสีผิวไม่สม่ำเสมอ กับสิ่งที่แต่ละอย่างตอบสนอง',
        },
      },
    },
    {
      code: 'hair-and-scalp',
      name: 'Hair & Scalp',
      summary: 'Washing, conditioning, and treating the scalp as skin.',
      goals: ['hair-care'],
      translations: {
        th: {
          name: 'เส้นผมและหนังศีรษะ',
          summary: 'การสระ การบำรุง และการดูแลหนังศีรษะเหมือนผิวหนัง',
        },
      },
    },
    {
      code: 'teeth-and-gums',
      name: 'Teeth & Gums',
      summary: 'Brushing, cleaning between teeth, and rinsing.',
      goals: ['oral-care'],
      translations: {
        th: {
          name: 'ฟันและเหงือก',
          summary: 'การแปรงฟัน การทำความสะอาดซอกฟัน และการบ้วนปาก',
        },
      },
    },
    {
      code: 'body-and-hands',
      name: 'Body & Hands',
      summary: 'Washing without stripping, and looking after hands that work.',
      goals: ['body-care'],
      translations: {
        th: {
          name: 'ร่างกายและมือ',
          summary: 'ทำความสะอาดโดยไม่ทำให้ผิวแห้ง และดูแลมือที่ใช้งานหนัก',
        },
      },
    },
    {
      code: 'water-at-home',
      name: 'Water at Home',
      summary: 'What tap water carries, and what a filter removes.',
      goals: ['clean-water'],
      translations: {
        th: {
          name: 'น้ำในบ้าน',
          summary: 'น้ำประปาพาอะไรมาบ้าง และเครื่องกรองเอาอะไรออก',
        },
      },
    },
    {
      code: 'air-at-home',
      name: 'Air at Home',
      summary: 'Dust, smoke and PM2.5 indoors, and how filtration works.',
      goals: ['clean-air'],
      translations: {
        th: {
          name: 'อากาศในบ้าน',
          summary: 'ฝุ่น ควัน และ PM2.5 ในบ้าน กับหลักการกรองอากาศ',
        },
      },
    },
    {
      code: 'household-cleaning',
      name: 'Household Cleaning',
      summary: 'Cleaning products, what they are for, and using less of them.',
      goals: ['a-cleaner-home'],
      translations: {
        th: {
          name: 'การทำความสะอาดบ้าน',
          summary: 'ผลิตภัณฑ์ทำความสะอาด ใช้ทำอะไร และวิธีใช้ให้น้อยลง',
        },
      },
    },
    {
      code: 'cookware-and-food',
      name: 'Cookware & Food Handling',
      summary: 'Pans, heat, and keeping food safe from kitchen to plate.',
      goals: ['a-cleaner-home'],
      translations: {
        th: {
          name: 'เครื่องครัวและการจัดการอาหาร',
          summary: 'หม้อกระทะ ความร้อน และการรักษาความปลอดภัยของอาหารจากครัวถึงจาน',
        },
      },
    },
  ],
  ingredients: [
    {
      code: 'magnesium',
      name: 'Magnesium',
      summary:
        'A mineral involved in muscle relaxation and normal nervous-system function. Commonly obtained from leafy greens, nuts, seeds and whole grains.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['sleep-hygiene', 'evening-nutrition'],
      translations: {
        th: {
          name: 'แมกนีเซียม',
          summary:
            'แร่ธาตุที่เกี่ยวข้องกับการคลายตัวของกล้ามเนื้อและการทำงานปกติของระบบประสาท พบได้ในผักใบเขียว ถั่ว เมล็ดพืช และธัญพืชไม่ขัดสี',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'l-theanine',
      name: 'L-Theanine',
      summary:
        'An amino acid found naturally in tea leaves, often discussed in the context of relaxation without sedation.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. Consult a qualified healthcare professional before use if pregnant, nursing, or taking medication.',
      topics: ['sleep-hygiene'],
      translations: {
        th: {
          name: 'แอล-ธีอะนีน',
          summary:
            'กรดอะมิโนที่พบตามธรรมชาติในใบชา มักถูกพูดถึงในบริบทของการผ่อนคลายโดยไม่ทำให้ง่วงซึม',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ควรปรึกษาบุคลากรทางการแพทย์ก่อนใช้หากตั้งครรภ์ ให้นมบุตร หรือใช้ยาประจำ',
        },
      },
    },
    // Ingredients named in Amway Thailand's own product text — the Thai
    // descriptions list what is in each product, so these are read from the
    // catalogue rather than invented for it (docs/74 §5).
    //
    // Every summary here is DESCRIPTIVE: what the thing is, where it ordinarily
    // comes from, and at most the context it is studied in. None of them claims
    // an effect. A supplement catalogue's own words are marketing, and copying
    // them would put a health claim this platform cannot stand behind in front
    // of a member who trusts it. The safety note is the same sentence on every
    // one, in both languages, for the same reason.
    {
      code: 'plant-protein',
      name: 'Plant Protein',
      summary:
        'Protein from sources such as soy, pea and rice. Protein contributes to the maintenance of muscle mass and is present in every ordinary meal that contains beans, grains, dairy, eggs, fish or meat.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['training-nutrition', 'energy-balance'],
      translations: {
        th: {
          name: 'โปรตีนจากพืช',
          summary:
            'โปรตีนจากแหล่งพืชเช่นถั่วเหลือง ถั่วลันเตา และข้าว โปรตีนเป็นส่วนประกอบของการรักษามวลกล้ามเนื้อ และมีอยู่ในมื้ออาหารทั่วไปที่มีถั่ว ธัญพืช นม ไข่ ปลา หรือเนื้อสัตว์',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'amino-acids',
      name: 'Essential Amino Acids',
      summary:
        'The nine amino acids the body cannot make and must take from food. Complete sources include eggs, dairy, soy, fish and meat.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['training-nutrition'],
      translations: {
        th: {
          name: 'กรดอะมิโนจำเป็น',
          summary:
            'กรดอะมิโนเก้าชนิดที่ร่างกายสร้างเองไม่ได้ ต้องได้รับจากอาหาร แหล่งที่ครบถ้วนได้แก่ ไข่ นม ถั่วเหลือง ปลา และเนื้อสัตว์',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'acerola-cherry',
      name: 'Acerola Cherry',
      summary:
        'A tropical fruit, notable for being among the richest natural sources of vitamin C.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['immune-support', 'nutrient-gaps'],
      translations: {
        th: {
          name: 'อะเซโรลาเชอร์รี',
          summary: 'ผลไม้เขตร้อน เป็นแหล่งวิตามินซีตามธรรมชาติที่มีปริมาณสูงที่สุดชนิดหนึ่ง',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'dietary-fibre',
      name: 'Dietary Fibre',
      summary:
        'The part of plant food that passes through undigested. Found in vegetables, fruit, whole grains, beans and nuts, and associated with normal bowel function.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver', 'energy-balance'],
      translations: {
        th: {
          name: 'ใยอาหาร',
          summary:
            'ส่วนของพืชที่ผ่านระบบย่อยโดยไม่ถูกย่อย พบในผัก ผลไม้ ธัญพืชไม่ขัดสี ถั่ว และเมล็ดพืช เกี่ยวข้องกับการทำงานปกติของลำไส้',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'phytonutrients',
      name: 'Phytonutrients',
      summary:
        'Plant compounds that give fruit and vegetables their colour — carotenoids, flavonoids and others. Eating a range of colours is the ordinary way to get a range of these.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'ไฟโตนิวเทรียนท์',
          summary:
            'สารจากพืชที่ให้สีแก่ผักและผลไม้ เช่น แคโรทีนอยด์และฟลาโวนอยด์ การกินผักผลไม้หลายสีคือวิธีปกติที่จะได้รับสารกลุ่มนี้ให้หลากหลาย',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'vitamin-c',
      name: 'Vitamin C',
      summary:
        'A water-soluble vitamin the body does not store. Found in citrus, guava, berries and peppers, and involved in normal collagen formation and immune function.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['immune-support', 'skin-from-within'],
      translations: {
        th: {
          name: 'วิตามินซี',
          summary:
            'วิตามินที่ละลายในน้ำและร่างกายไม่เก็บสะสม พบในส้ม ฝรั่ง เบอร์รี และพริกหวาน เกี่ยวข้องกับการสร้างคอลลาเจนและการทำงานปกติของภูมิคุ้มกัน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'calcium',
      name: 'Calcium',
      summary:
        'The mineral bone is largely built from. Dairy, small fish eaten with bones, tofu and dark leafy greens are common sources.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['bone-and-joint'],
      translations: {
        th: {
          name: 'แคลเซียม',
          summary:
            'แร่ธาตุหลักที่เป็นโครงสร้างของกระดูก แหล่งที่พบบ่อยคือ นม ปลาเล็กปลาน้อยที่กินทั้งกระดูก เต้าหู้ และผักใบเขียวเข้ม',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'cla',
      name: 'Conjugated Linoleic Acid (CLA)',
      summary:
        'A fatty acid found naturally in dairy and beef, and studied in the context of body composition.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['energy-balance'],
      translations: {
        th: {
          name: 'กรดลิโนเลอิกชนิดคอนจูเกต (CLA)',
          summary: 'กรดไขมันที่พบตามธรรมชาติในนมและเนื้อวัว มีการศึกษาในบริบทของสัดส่วนร่างกาย',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'omega-3',
      name: 'Omega-3 Fatty Acids',
      summary:
        'Fats the body cannot make, obtained from oily fish, flaxseed and walnuts. EPA and DHA are the forms most discussed for heart and brain function.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['heart-and-circulation'],
      translations: {
        th: {
          name: 'กรดไขมันโอเมก้า-3',
          summary:
            'ไขมันที่ร่างกายสร้างเองไม่ได้ ได้จากปลาทะเลน้ำลึก เมล็ดแฟลกซ์ และวอลนัท รูปแบบที่พูดถึงบ่อยคือ EPA และ DHA ในบริบทของหัวใจและสมอง',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'green-tea',
      name: 'Green Tea Extract',
      summary:
        'An extract of Camellia sinensis leaves, carrying catechins and a small amount of caffeine.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['energy-balance'],
      translations: {
        th: {
          name: 'สารสกัดชาเขียว',
          summary: 'สารสกัดจากใบชา Camellia sinensis มีคาเทชินและคาเฟอีนปริมาณเล็กน้อย',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'vitamin-b-complex',
      name: 'Vitamin B Complex',
      summary:
        'A group of eight water-soluble vitamins involved in turning food into energy. Whole grains, eggs, dairy, meat and legumes are ordinary sources.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'วิตามินบีรวม',
          summary:
            'กลุ่มวิตามินที่ละลายในน้ำแปดชนิด เกี่ยวข้องกับการเปลี่ยนอาหารเป็นพลังงาน แหล่งปกติคือ ธัญพืชไม่ขัดสี ไข่ นม เนื้อสัตว์ และถั่ว',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'probiotic',
      name: 'Probiotics',
      summary:
        'Live micro-organisms, most commonly Lactobacillus and Bifidobacterium, found in yoghurt and fermented foods.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver'],
      translations: {
        th: {
          name: 'โพรไบโอติก',
          summary:
            'จุลินทรีย์มีชีวิต ที่พบบ่อยคือกลุ่ม Lactobacillus และ Bifidobacterium พบในโยเกิร์ตและอาหารหมัก',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'collagen',
      name: 'Collagen',
      summary:
        'The most abundant structural protein in skin, bone and connective tissue. Supplement forms are usually hydrolysed into shorter peptides.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-from-within', 'bone-and-joint'],
      translations: {
        th: {
          name: 'คอลลาเจน',
          summary:
            'โปรตีนโครงสร้างที่มีมากที่สุดในผิวหนัง กระดูก และเนื้อเยื่อเกี่ยวพัน รูปแบบอาหารเสริมมักผ่านการย่อยเป็นเปปไทด์สายสั้น',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'zinc',
      name: 'Zinc',
      summary:
        'A trace mineral involved in normal immune function and wound healing. Oysters, meat, beans and seeds are common sources.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['immune-support'],
      translations: {
        th: {
          name: 'สังกะสี',
          summary:
            'แร่ธาตุปริมาณน้อยที่เกี่ยวข้องกับการทำงานปกติของภูมิคุ้มกันและการสมานแผล แหล่งที่พบบ่อยคือ หอยนางรม เนื้อสัตว์ ถั่ว และเมล็ดพืช',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'coq10',
      name: 'Coenzyme Q10',
      summary:
        'A compound present in every cell and involved in energy production, with the highest concentrations in the heart. The body makes it, and amounts decline with age.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['heart-and-circulation'],
      translations: {
        th: {
          name: 'โคเอนไซม์ คิวเท็น',
          summary:
            'สารที่มีอยู่ในทุกเซลล์และเกี่ยวข้องกับการสร้างพลังงาน พบมากที่สุดในหัวใจ ร่างกายสร้างเองได้และปริมาณลดลงตามอายุ',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'garlic',
      name: 'Garlic',
      summary:
        'A culinary bulb, studied in the context of cardiovascular health. Its characteristic compounds form when it is crushed or chopped.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['heart-and-circulation'],
      translations: {
        th: {
          name: 'กระเทียม',
          summary:
            'พืชหัวที่ใช้ปรุงอาหาร มีการศึกษาในบริบทของสุขภาพหัวใจและหลอดเลือด สารประจำตัวของมันเกิดขึ้นเมื่อถูกทุบหรือสับ',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'spinach',
      name: 'Spinach',
      summary: 'A dark leafy green carrying folate, iron, magnesium and lutein.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'ผักโขม',
          summary: 'ผักใบเขียวเข้มที่มีโฟเลต ธาตุเหล็ก แมกนีเซียม และลูทีน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'ginkgo-biloba',
      name: 'Ginkgo Biloba',
      summary:
        'An extract of the leaves of the ginkgo tree, traditionally used and studied in the context of circulation.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['heart-and-circulation'],
      translations: {
        th: {
          name: 'แปะก๊วย',
          summary: 'สารสกัดจากใบแปะก๊วย ใช้มาแต่โบราณและมีการศึกษาในบริบทของการไหลเวียนเลือด',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'licorice',
      name: 'Licorice',
      summary:
        'The root of Glycyrrhiza glabra, used as a flavouring and in traditional preparations for the digestive tract.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver'],
      translations: {
        th: {
          name: 'ชะเอมเทศ',
          summary:
            'รากของ Glycyrrhiza glabra ใช้แต่งกลิ่นรสและใช้ในตำรับดั้งเดิมเกี่ยวกับระบบทางเดินอาหาร',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'moro-blood-orange',
      name: 'Moro Blood Orange',
      summary:
        'A pigmented Sicilian orange whose colour comes from anthocyanins; its extract is studied in the context of body composition.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['energy-balance'],
      translations: {
        th: {
          name: 'ส้มสีเลือดโมโร',
          summary:
            'ส้มพันธุ์ซิซิลีที่มีสีจากแอนโทไซยานิน สารสกัดของมันมีการศึกษาในบริบทของสัดส่วนร่างกาย',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'parsley',
      name: 'Parsley',
      summary: 'A culinary herb carrying vitamin K, vitamin C and folate.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'พาร์สลีย์',
          summary: 'สมุนไพรที่ใช้ปรุงอาหาร มีวิตามินเค วิตามินซี และโฟเลต',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'evening-primrose',
      name: 'Evening Primrose Oil',
      summary: 'An oil pressed from the seeds of Oenothera biennis, carrying gamma-linolenic acid.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-from-within'],
      translations: {
        th: {
          name: 'น้ำมันอีฟนิ่งพริมโรส',
          summary: 'น้ำมันที่สกัดจากเมล็ด Oenothera biennis มีกรดแกมมา-ลิโนเลนิก',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'mixed-carotenoids',
      name: 'Mixed Carotenoids',
      summary:
        'The orange, red and yellow pigments of plants — beta-carotene, lycopene, lutein and others. Carrots, tomatoes, pumpkin and dark greens carry them.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps', 'skin-from-within'],
      translations: {
        th: {
          name: 'แคโรทีนอยด์รวม',
          summary:
            'รงควัตถุสีส้ม แดง และเหลืองในพืช เช่น เบตาแคโรทีน ไลโคปีน และลูทีน พบในแครอท มะเขือเทศ ฟักทอง และผักใบเขียวเข้ม',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'cistanche',
      name: 'Cistanche',
      summary: 'A desert plant used in traditional Chinese preparations as a tonic.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'ซิสแทนเช',
          summary: 'พืชทะเลทรายที่ใช้ในตำรับจีนโบราณในฐานะยาบำรุง',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'vitamin-d',
      name: 'Vitamin D',
      summary:
        'Made in skin exposed to sunlight and found in oily fish and egg yolk. Involved in calcium absorption and normal immune function.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['bone-and-joint', 'immune-support'],
      translations: {
        th: {
          name: 'วิตามินดี',
          summary:
            'ร่างกายสร้างได้เมื่อผิวได้รับแสงแดด และพบในปลาที่มีไขมันสูงและไข่แดง เกี่ยวข้องกับการดูดซึมแคลเซียมและการทำงานปกติของภูมิคุ้มกัน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'iron',
      name: 'Iron',
      summary:
        'A mineral carried in red blood cells to move oxygen. Red meat, liver, beans and dark greens are common sources; vitamin C helps absorption from plants.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'ธาตุเหล็ก',
          summary:
            'แร่ธาตุในเม็ดเลือดแดงที่ทำหน้าที่ลำเลียงออกซิเจน แหล่งที่พบบ่อยคือ เนื้อแดง ตับ ถั่ว และผักใบเขียวเข้ม วิตามินซีช่วยการดูดซึมจากพืช',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'cinnamon',
      name: 'Cinnamon',
      summary:
        'The inner bark of Cinnamomum trees, used as a spice and studied in the context of blood sugar.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['energy-balance'],
      translations: {
        th: {
          name: 'อบเชย',
          summary:
            'เปลือกชั้นในของต้น Cinnamomum ใช้เป็นเครื่องเทศ และมีการศึกษาในบริบทของระดับน้ำตาลในเลือด',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'picao-preto',
      name: 'Picão Preto',
      summary: 'Bidens pilosa, a plant used in South American traditional preparations.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['immune-support'],
      translations: {
        th: {
          name: 'พิเคา เพรโต',
          summary: 'Bidens pilosa พืชที่ใช้ในตำรับดั้งเดิมของอเมริกาใต้',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'jujube',
      name: 'Jujube',
      summary:
        'The fruit of Ziziphus jujuba, used in Chinese traditional preparations, often in the context of rest.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['sleep-hygiene'],
      translations: {
        th: {
          name: 'พุทราจีน',
          summary: 'ผลของ Ziziphus jujuba ใช้ในตำรับจีนโบราณ มักอยู่ในบริบทของการพักผ่อน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'lingzhi',
      name: 'Lingzhi (Reishi)',
      summary: 'Ganoderma lucidum, a mushroom used in East Asian traditional preparations.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['immune-support'],
      translations: {
        th: {
          name: 'เห็ดหลินจือ',
          summary: 'Ganoderma lucidum เห็ดที่ใช้ในตำรับดั้งเดิมของเอเชียตะวันออก',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'turmeric',
      name: 'Turmeric',
      summary:
        'The rhizome of Curcuma longa, a kitchen spice whose yellow colour comes from curcumin.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver'],
      translations: {
        th: {
          name: 'ขมิ้นชัน',
          summary: 'เหง้าของ Curcuma longa เครื่องเทศในครัวที่มีสีเหลืองจากเคอร์คูมิน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'vitamin-e',
      name: 'Vitamin E',
      summary:
        'A fat-soluble vitamin found in vegetable oils, nuts and seeds, acting as an antioxidant in cell membranes.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-from-within'],
      translations: {
        th: {
          name: 'วิตามินอี',
          summary:
            'วิตามินที่ละลายในไขมัน พบในน้ำมันพืช ถั่ว และเมล็ดพืช ทำหน้าที่เป็นสารต้านอนุมูลอิสระในเยื่อหุ้มเซลล์',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'lecithin',
      name: 'Lecithin',
      summary:
        'A mixture of phospholipids from soy or egg yolk, used in food as an emulsifier and a source of choline.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['heart-and-circulation'],
      translations: {
        th: {
          name: 'เลซิติน',
          summary:
            'กลุ่มฟอสโฟลิพิดจากถั่วเหลืองหรือไข่แดง ใช้ในอาหารเป็นสารช่วยผสมและเป็นแหล่งของโคลีน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'watercress',
      name: 'Watercress',
      summary: 'A peppery leafy green carrying vitamin K, vitamin C and glucosinolates.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'วอเตอร์เครส',
          summary: 'ผักใบเขียวรสเผ็ดเล็กน้อย มีวิตามินเค วิตามินซี และกลูโคซิโนเลต',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'siberian-ginseng',
      name: 'Siberian Ginseng',
      summary:
        'Eleutherococcus senticosus — not a true ginseng — used in traditional preparations and described as an adaptogen.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['training-nutrition', 'nutrient-gaps'],
      translations: {
        th: {
          name: 'โสมไซบีเรีย',
          summary:
            'Eleutherococcus senticosus ซึ่งไม่ใช่โสมแท้ ใช้ในตำรับดั้งเดิมและถูกจัดอยู่ในกลุ่มอะแดปโตเจน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    // A second pass over the same catalogue (docs/74 §5). The first read the
    // product NAMES; these came from `short_description`, where Amway lists what
    // is actually in the bottle — which is how the one supplement that had
    // resisted linking, Ostkeeper, turned out to be pomegranate and grape seed.
    {
      code: 'grape-seed',
      name: 'Grape Seed Extract',
      summary:
        'An extract of grape seeds carrying proanthocyanidins, the same family of compounds that colours red wine.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-from-within', 'heart-and-circulation'],
      translations: {
        th: {
          name: 'สารสกัดเมล็ดองุ่น',
          summary: 'สารสกัดจากเมล็ดองุ่นซึ่งมีโปรแอนโทไซยานิดิน สารกลุ่มเดียวกับที่ให้สีแก่ไวน์แดง',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'pomegranate',
      name: 'Pomegranate',
      summary: 'The fruit of Punica granatum, carrying punicalagins and anthocyanins.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['bone-and-joint', 'heart-and-circulation'],
      translations: {
        th: {
          name: 'ทับทิม',
          summary: 'ผลของ Punica granatum มีสารพูนิคาลาจินและแอนโทไซยานิน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'cranberry',
      name: 'Cranberry',
      summary:
        'A tart North American berry carrying proanthocyanidins, traditionally taken in the context of urinary health.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['immune-support'],
      translations: {
        th: {
          name: 'แครนเบอร์รี',
          summary:
            'เบอร์รีรสเปรี้ยวจากอเมริกาเหนือ มีโปรแอนโทไซยานิดิน มักรับประทานในบริบทของสุขภาพทางเดินปัสสาวะ',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'green-coffee-bean',
      name: 'Green Coffee Bean',
      summary:
        'Unroasted coffee beans, which retain chlorogenic acid that roasting largely destroys.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['energy-balance'],
      translations: {
        th: {
          name: 'เมล็ดกาแฟเขียว',
          summary:
            'เมล็ดกาแฟที่ยังไม่ผ่านการคั่ว จึงยังคงกรดคลอโรจีนิกซึ่งการคั่วทำลายไปเป็นส่วนใหญ่',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'lycopene',
      name: 'Lycopene',
      summary:
        'The red carotenoid of tomatoes, watermelon and pink guava. Cooking with a little oil makes it easier to absorb.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps', 'heart-and-circulation'],
      translations: {
        th: {
          name: 'ไลโคปีน',
          summary:
            'แคโรทีนอยด์สีแดงในมะเขือเทศ แตงโม และฝรั่งสีชมพู การปรุงกับน้ำมันเล็กน้อยช่วยให้ดูดซึมง่ายขึ้น',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'broccoli',
      name: 'Broccoli',
      summary: 'A cruciferous vegetable carrying sulforaphane, vitamin C and vitamin K.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'บรอกโคลี',
          summary: 'ผักตระกูลกะหล่ำที่มีซัลโฟราเฟน วิตามินซี และวิตามินเค',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'dong-quai',
      name: 'Dong Quai',
      summary: 'Angelica sinensis, a root long used in Chinese traditional preparations.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-from-within'],
      translations: {
        th: {
          name: 'ตังกุย',
          summary: 'Angelica sinensis รากที่ใช้ในตำรับจีนโบราณมายาวนาน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'blueberry',
      name: 'Blueberry',
      summary: 'A berry whose deep colour comes from anthocyanins.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'บลูเบอร์รี',
          summary: 'เบอร์รีที่มีสีเข้มจากแอนโทไซยานิน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'alfalfa',
      name: 'Alfalfa',
      summary: 'A legume eaten as sprouts or leaf, carrying vitamin K and minerals.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'อัลฟัลฟา',
          summary: 'พืชตระกูลถั่วที่กินเป็นต้นอ่อนหรือใบ มีวิตามินเคและแร่ธาตุ',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'white-kidney-bean',
      name: 'White Kidney Bean',
      summary: 'A bean whose extract contains a protein that interferes with starch digestion.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['energy-balance'],
      translations: {
        th: {
          name: 'ถั่วขาว',
          summary: 'ถั่วที่สารสกัดของมันมีโปรตีนซึ่งรบกวนการย่อยแป้ง',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'chrysanthemum',
      name: 'Chrysanthemum',
      summary: 'The dried flower of Chrysanthemum morifolium, drunk as a tea in East Asia.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver'],
      translations: {
        th: {
          name: 'เก๊กฮวย',
          summary: 'ดอกแห้งของ Chrysanthemum morifolium ดื่มเป็นชาในเอเชียตะวันออก',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'wheat-sprout',
      name: 'Wheat Sprout Extract',
      summary: 'An extract of sprouted wheat, used as a source of plant enzymes and minerals.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'สารสกัดข้าวสาลีงอก',
          summary: 'สารสกัดจากข้าวสาลีที่งอกแล้ว ใช้เป็นแหล่งเอนไซม์จากพืชและแร่ธาตุ',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    // A third pass, over the product PAGE rather than its summary (docs/74 §5).
    // The page carries the full ingredient list — which is where a fibre blend
    // turns out to be nine plants and not one, and where a fruit-and-vegetable
    // concentrate names the ten it concentrates. Depth is not decoration here:
    // a member who arrives at lutein must find the product that contains it,
    // and one link per product would have hidden nine of every ten.
    {
      code: 'chia-seed',
      name: 'Chia Seed',
      summary: 'Seeds of Salvia hispanica, carrying fibre, plant omega-3 (ALA) and protein.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps', 'digestion-and-liver'],
      translations: {
        th: {
          name: 'เมล็ดเจีย',
          summary: 'เมล็ดของ Salvia hispanica มีใยอาหาร โอเมก้า-3 จากพืช (ALA) และโปรตีน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'lutein',
      name: 'Lutein',
      summary:
        'A yellow carotenoid concentrated in the retina, obtained from marigold flowers and dark leafy greens.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'ลูทีน',
          summary: 'แคโรทีนอยด์สีเหลืองที่สะสมอยู่ในจอตา ได้จากดอกดาวเรืองและผักใบเขียวเข้ม',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'carrot',
      name: 'Carrot',
      summary: 'A root vegetable and the most familiar source of beta-carotene.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'แครอท',
          summary: 'ผักรากที่เป็นแหล่งเบตาแคโรทีนที่คุ้นเคยที่สุด',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'biotin',
      name: 'Biotin',
      summary:
        'A B vitamin involved in normal hair, skin and nail structure. Eggs, nuts and liver carry it.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-from-within'],
      translations: {
        th: {
          name: 'ไบโอติน',
          summary:
            'วิตามินบีชนิดหนึ่งที่เกี่ยวข้องกับโครงสร้างปกติของผม ผิว และเล็บ พบในไข่ ถั่ว และตับ',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'folate',
      name: 'Folate',
      summary:
        'Vitamin B9, needed for normal cell division. Dark leafy greens, beans and liver are ordinary sources.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'โฟเลต',
          summary:
            'วิตามินบี 9 จำเป็นต่อการแบ่งเซลล์ตามปกติ แหล่งทั่วไปคือ ผักใบเขียวเข้ม ถั่ว และตับ',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'sea-buckthorn',
      name: 'Sea Buckthorn',
      summary: 'A shrub berry carrying vitamin C, carotenoids and omega-7 fatty acids.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-from-within', 'immune-support'],
      translations: {
        th: {
          name: 'ซีบัคธอร์น',
          summary: 'ผลของไม้พุ่มที่มีวิตามินซี แคโรทีนอยด์ และกรดไขมันโอเมก้า-7',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'copper',
      name: 'Copper',
      summary:
        'A trace mineral working alongside iron in the formation of red blood cells and connective tissue.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps'],
      translations: {
        th: {
          name: 'ทองแดง',
          summary:
            'แร่ธาตุปริมาณน้อยที่ทำงานร่วมกับธาตุเหล็กในการสร้างเม็ดเลือดแดงและเนื้อเยื่อเกี่ยวพัน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'manganese',
      name: 'Manganese',
      summary:
        'A trace mineral involved in bone formation and the metabolism of carbohydrate and fat.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['bone-and-joint'],
      translations: {
        th: {
          name: 'แมงกานีส',
          summary:
            'แร่ธาตุปริมาณน้อยที่เกี่ยวข้องกับการสร้างกระดูกและกระบวนการเผาผลาญคาร์โบไฮเดรตและไขมัน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'vitamin-a',
      name: 'Vitamin A',
      summary:
        'A fat-soluble vitamin involved in normal vision and skin. Liver, egg yolk and orange vegetables carry it or its precursor.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['nutrient-gaps', 'skin-from-within'],
      translations: {
        th: {
          name: 'วิตามินเอ',
          summary:
            'วิตามินที่ละลายในไขมัน เกี่ยวข้องกับการมองเห็นและผิวหนังตามปกติ พบในตับ ไข่แดง และผักสีส้มในรูปสารตั้งต้น',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'inulin',
      name: 'Inulin',
      summary:
        'A soluble plant fibre from chicory root and other plants, which passes to the large intestine undigested.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver'],
      translations: {
        th: {
          name: 'อินูลิน',
          summary: 'ใยอาหารชนิดละลายน้ำจากรากชิโครีและพืชอื่น ผ่านไปถึงลำไส้ใหญ่โดยไม่ถูกย่อย',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'oat-fibre',
      name: 'Oat Fibre',
      summary: 'The fibre fraction of oats, carrying beta-glucan.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver', 'heart-and-circulation'],
      translations: {
        th: {
          name: 'ใยอาหารข้าวโอ๊ต',
          summary: 'ส่วนใยอาหารของข้าวโอ๊ต ซึ่งมีเบต้ากลูแคน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'barley',
      name: 'Barley',
      summary: 'A cereal grain carrying soluble fibre, eaten whole or as a fibre source.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver'],
      translations: {
        th: {
          name: 'ข้าวบาร์เลย์',
          summary: 'ธัญพืชที่มีใยอาหารชนิดละลายน้ำ กินทั้งเมล็ดหรือใช้เป็นแหล่งใยอาหาร',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'apple',
      name: 'Apple',
      summary: 'A fruit whose skin and flesh carry pectin, a soluble fibre.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver'],
      translations: {
        th: {
          name: 'แอปเปิ้ล',
          summary: 'ผลไม้ที่เปลือกและเนื้อมีเพกติน ซึ่งเป็นใยอาหารชนิดละลายน้ำ',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'pea-fibre',
      name: 'Pea Fibre',
      summary: 'The fibre fraction of the field pea, used as a bulking fibre.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver'],
      translations: {
        th: {
          name: 'ใยอาหารถั่วลันเตา',
          summary: 'ส่วนใยอาหารของถั่วลันเตา ใช้เป็นใยอาหารเพิ่มกาก',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'cactus-fibre',
      name: 'Cactus Fibre',
      summary: 'Fibre from the prickly pear cactus pad.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver'],
      translations: {
        th: {
          name: 'ใยอาหารกระบองเพชร',
          summary: 'ใยอาหารจากใบของกระบองเพชรสกุลออพันเทีย',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'sugarcane-fibre',
      name: 'Sugarcane Fibre',
      summary: 'The insoluble fibre left after sugar is pressed from the cane.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver'],
      translations: {
        th: {
          name: 'ใยอาหารจากอ้อย',
          summary: 'ใยอาหารชนิดไม่ละลายน้ำที่เหลือจากการหีบน้ำตาลออกจากอ้อย',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'borage-oil',
      name: 'Borage Oil',
      summary:
        'An oil pressed from borage seeds, the richest common source of gamma-linolenic acid.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-from-within'],
      translations: {
        th: {
          name: 'น้ำมันโบราจ',
          summary:
            'น้ำมันจากเมล็ดโบราจ เป็นแหล่งกรดแกมมา-ลิโนเลนิกที่เข้มข้นที่สุดในบรรดาแหล่งทั่วไป',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'ginger',
      name: 'Ginger',
      summary:
        'The rhizome of Zingiber officinale, a kitchen spice used in traditional preparations for digestion.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['digestion-and-liver'],
      translations: {
        th: {
          name: 'ขิง',
          summary:
            'เหง้าของ Zingiber officinale เครื่องเทศในครัวที่ใช้ในตำรับดั้งเดิมเกี่ยวกับการย่อยอาหาร',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'elderberry',
      name: 'Elderberry',
      summary:
        'The dark berry of Sambucus, carrying anthocyanins and traditionally taken in winter.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['immune-support'],
      translations: {
        th: {
          name: 'เอลเดอร์เบอร์รี',
          summary: 'ผลสีเข้มของ Sambucus มีแอนโทไซยานิน ตามธรรมเนียมรับประทานในฤดูหนาว',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'gold-kiwi',
      name: 'Gold Kiwi',
      summary: 'A yellow-fleshed kiwifruit, carrying more vitamin C by weight than an orange.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['immune-support', 'digestion-and-liver'],
      translations: {
        th: {
          name: 'กีวีสีทอง',
          summary: 'กีวีเนื้อสีเหลือง มีวิตามินซีต่อน้ำหนักมากกว่าส้ม',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    // Cosmetic and personal-care ingredients, read from the same catalogue.
    // Fewer than the supplement side, and that is honest: a shampoo's page
    // names two or three things, where a multivitamin's names twenty.
    {
      code: 'ceramide',
      name: 'Ceramides',
      summary:
        "Lipids that make up part of the skin's outer barrier, also used in leave-on products.",
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-routine', 'hair-and-scalp'],
      translations: {
        th: {
          name: 'เซราไมด์',
          summary:
            'ไขมันที่เป็นส่วนหนึ่งของเกราะผิวชั้นนอก และใช้ในผลิตภัณฑ์บำรุงที่ไม่ต้องล้างออก',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'argan-oil',
      name: 'Argan Oil',
      summary: 'An oil pressed from the kernels of the Moroccan argan tree.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['hair-and-scalp', 'body-and-hands'],
      translations: {
        th: {
          name: 'น้ำมันอาร์แกน',
          summary: 'น้ำมันจากเมล็ดในของต้นอาร์แกนในโมร็อกโก',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'peptide',
      name: 'Peptides',
      summary: 'Short chains of amino acids used in leave-on skin products.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-routine', 'skin-concerns'],
      translations: {
        th: {
          name: 'เปปไทด์',
          summary: 'สายกรดอะมิโนสายสั้นที่ใช้ในผลิตภัณฑ์บำรุงผิวชนิดไม่ล้างออก',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'honey',
      name: 'Honey',
      summary: 'A humectant sugar syrup made by bees, used in food and in skin products.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['body-and-hands', 'nutrient-gaps'],
      translations: {
        th: {
          name: 'น้ำผึ้ง',
          summary: 'น้ำเชื่อมจากผึ้งที่อุ้มความชื้น ใช้ทั้งในอาหารและผลิตภัณฑ์บำรุงผิว',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'shea-butter',
      name: 'Shea Butter',
      summary: 'A fat pressed from the nut of the shea tree, solid at room temperature.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['body-and-hands'],
      translations: {
        th: {
          name: 'เชียบัตเตอร์',
          summary: 'ไขมันจากเมล็ดต้นเชีย เป็นของแข็งที่อุณหภูมิห้อง',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'rice-extract',
      name: 'Rice Extract',
      summary: 'An extract of rice grain or bran, long used in East Asian preparations.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-routine'],
      translations: {
        th: {
          name: 'สารสกัดข้าว',
          summary: 'สารสกัดจากเมล็ดข้าวหรือรำข้าว ใช้ในตำรับเอเชียตะวันออกมายาวนาน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'ginseng',
      name: 'Ginseng',
      summary: 'Panax ginseng root, used in traditional preparations and in skin products.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-routine', 'nutrient-gaps'],
      translations: {
        th: {
          name: 'โสม',
          summary: 'รากโสม Panax ginseng ใช้ในตำรับดั้งเดิมและในผลิตภัณฑ์บำรุงผิว',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'aloe-vera',
      name: 'Aloe Vera',
      summary: 'The gel inside the leaf of Aloe barbadensis, mostly water and polysaccharides.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['body-and-hands', 'skin-routine'],
      translations: {
        th: {
          name: 'ว่านหางจระเข้',
          summary: 'วุ้นในใบของ Aloe barbadensis ส่วนใหญ่เป็นน้ำและพอลิแซ็กคาไรด์',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'fluoride',
      name: 'Fluoride',
      summary: 'A mineral added to toothpaste and water supplies, involved in enamel hardness.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['teeth-and-gums'],
      translations: {
        th: {
          name: 'ฟลูออไรด์',
          summary: 'แร่ธาตุที่เติมในยาสีฟันและน้ำประปา เกี่ยวข้องกับความแข็งของเคลือบฟัน',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
    {
      code: 'seaweed-extract',
      name: 'Seaweed Extract',
      summary: 'An extract of marine algae, carrying minerals and polysaccharides.',
      safetyNotes:
        'General wellness information only. Not a treatment for any condition. People who are pregnant, taking medication, or living with a health condition should speak with a qualified healthcare professional before changing supplementation.',
      topics: ['skin-routine'],
      translations: {
        th: {
          name: 'สารสกัดสาหร่ายทะเล',
          summary: 'สารสกัดจากสาหร่ายทะเล มีแร่ธาตุและพอลิแซ็กคาไรด์',
          safetyNotes:
            'เป็นข้อมูลสุขภาพทั่วไปเท่านั้น ไม่ใช่การรักษาโรคใด ผู้ที่ตั้งครรภ์ ใช้ยาประจำ หรือมีโรคประจำตัว ควรปรึกษาบุคลากรทางการแพทย์ก่อนปรับการเสริมอาหาร',
        },
      },
    },
  ],
  articles: [
    {
      slug: 'winding-down-an-evening-routine-that-works',
      title: 'Winding Down: An Evening Routine That Works',
      summary:
        'A practical, product-free routine for the two hours before bed, and where nutrition fits in.',
      body: [
        'Good sleep is built during the day, not in the last ten minutes before bed.',
        '',
        'Start with light: dim the room and step away from bright screens about an hour before you plan to sleep. Keep the bedroom cool and dark, and keep a consistent wake time — even on weekends, since the wake time anchors the whole rhythm.',
        '',
        'Evening nutrition matters more than most people expect. Large late meals, alcohol, and caffeine after mid-afternoon all fragment sleep. A lighter evening meal a few hours before bed gives digestion time to settle.',
        '',
        'Several nutrients come up in conversations about relaxation and sleep — magnesium and L-theanine among them. Food sources come first: leafy greens, nuts, seeds, whole grains, and tea are ordinary places these appear. Supplementation is a personal decision best discussed with a qualified healthcare professional, especially alongside medication.',
        '',
        'None of this is a treatment for a sleep disorder. Persistent sleep problems deserve a conversation with a doctor.',
      ].join('\n'),
      topics: ['sleep-hygiene', 'evening-nutrition'],
      ingredients: ['magnesium', 'l-theanine'],
      translations: {
        th: {
          title: 'ผ่อนคลายก่อนนอน: กิจวัตรตอนเย็นที่ได้ผลจริง',
          summary:
            'กิจวัตรสองชั่วโมงก่อนเข้านอนที่ทำได้จริงโดยไม่ต้องพึ่งสินค้า และโภชนาการเข้ามาเกี่ยวข้องตรงไหน',
          body: [
            'การนอนหลับที่ดีถูกสร้างขึ้นระหว่างวัน ไม่ใช่ในสิบนาทีสุดท้ายก่อนเข้านอน',
            '',
            'เริ่มจากแสง: หรี่ไฟและเลี่ยงหน้าจอสว่างประมาณหนึ่งชั่วโมงก่อนเวลานอน ทำให้ห้องนอนเย็นและมืด และรักษาเวลาตื่นให้สม่ำเสมอแม้ในวันหยุด เพราะเวลาตื่นคือหมุดยึดของนาฬิกาชีวิต',
            '',
            'โภชนาการมื้อเย็นสำคัญกว่าที่หลายคนคิด มื้อหนักดึก แอลกอฮอล์ และคาเฟอีนหลังบ่ายล้วนทำให้การนอนขาดช่วง มื้อเย็นที่เบากว่าและห่างจากเวลานอนสองสามชั่วโมงช่วยให้ระบบย่อยได้พัก',
            '',
            'สารอาหารหลายชนิดถูกพูดถึงในบริบทของการผ่อนคลายและการนอน เช่น แมกนีเซียมและแอล-ธีอะนีน แหล่งจากอาหารมาก่อนเสมอ ได้แก่ ผักใบเขียว ถั่ว เมล็ดพืช ธัญพืชไม่ขัดสี และชา ส่วนการเสริมอาหารเป็นการตัดสินใจส่วนบุคคลที่ควรปรึกษาบุคลากรทางการแพทย์ โดยเฉพาะเมื่อใช้ร่วมกับยา',
            '',
            'ทั้งหมดนี้ไม่ใช่การรักษาโรคเกี่ยวกับการนอน หากมีปัญหาการนอนเรื้อรัง ควรปรึกษาแพทย์',
          ].join('\n'),
        },
      },
    },
    {
      slug: 'how-a-stairstep-plan-pays',
      title: 'How a Stairstep Plan Pays',
      summary:
        'Retail margin, the percentage ladder, differential and breakaway — the four mechanics behind most network compensation plans, with Amway’s as the worked example.',
      body: [
        'Most network compensation plans belong to one family, called stairstep–breakaway. Four mechanics do all the work, and they are easier to follow in order than in a table.',
        '',
        '1 · Retail margin. The gap between what you pay for a product and what a customer pays for it. It involves no downline at all, it is the first income in every plan of this family, and it is the part most often left out of the explanation.',
        '',
        '2 · The ladder. Products carry two figures: PV, which ranks you, and BV, which is the money the percentage multiplies. The split exists so a price change or an exchange rate cannot move somebody up or down the ladder. Your group’s PV in a calendar month buys a percentage. Amway’s classic scale runs 3% at 200 PV, then 6% · 9% · 12% · 15% · 18% and 21% at 10,000 PV. The rungs reset every month: a level is re-earned, not kept.',
        '',
        '3 · Differential. You are paid your own percentage minus the percentage already paid to the line the volume came through. At 21% with a line running at 15%, you receive the 6% difference on that line’s BV. This is why the plan is called a stairstep — you are paid for the height of the step between you and the person below.',
        '',
        '4 · Breakaway. When a line reaches the top rung, it breaks away: its volume stops counting toward your group total and the differential on it ends. In its place you receive a leadership bonus on that line, and — at higher levels — bonuses reaching further down. This is the reason the ranks above the ladder are counted in lines rather than in volume: three qualified lines, six qualified lines, and so on, each with its own name.',
        '',
        'Two things follow from this that are worth holding on to. Breaking away is not a loss; a plan that punished you for building a strong leader would stop anybody from building one. And the plans in this family pay on product volume, never on somebody joining — that distinction is what separates a lawful compensation plan from a scheme, and it is worth being able to state plainly.',
        '',
        'The figures above are Amway’s published Thailand scale and are used here because it is the oldest and best documented plan of this kind. Every company sets its own numbers, every market differs, and they are revised. For anything you intend to act on, read the plan your own business operates under.',
      ].join('\n'),
      topics: [],
      ingredients: [],
      translations: {
        th: {
          title: 'แผนแบบขั้นบันไดจ่ายเงินอย่างไร',
          summary:
            'กำไรขายปลีก ขั้นบันไดเปอร์เซ็นต์ ส่วนต่าง และการแยกสาย — สี่กลไกเบื้องหลังแผนการตลาดเครือข่ายส่วนใหญ่ โดยใช้แผนของแอมเวย์เป็นตัวอย่างประกอบ',
          body: [
            'แผนการตลาดเครือข่ายส่วนใหญ่อยู่ในตระกูลเดียวกัน เรียกว่าแบบขั้นบันไดและแยกสาย (stairstep–breakaway) มีสี่กลไกที่ทำงานทั้งหมด และเข้าใจง่ายกว่าถ้าไล่ทีละข้อ',
            '',
            '1 · กำไรขายปลีก คือส่วนต่างระหว่างราคาที่คุณซื้อกับราคาที่ลูกค้าจ่าย ไม่เกี่ยวกับสายงานเลยแม้แต่น้อย เป็นรายได้ก้อนแรกของทุกแผนในตระกูลนี้ และเป็นส่วนที่ถูกละไว้บ่อยที่สุดเวลาอธิบาย',
            '',
            '2 · ขั้นบันได สินค้าแต่ละชิ้นมีสองตัวเลข คือ PV ซึ่งใช้จัดระดับ และ BV ซึ่งเป็นฐานเงินที่เปอร์เซ็นต์ไปคูณ ที่ต้องแยกกันเพราะการปรับราคาหรืออัตราแลกเปลี่ยนจะได้ไม่ทำให้ใครเลื่อนขั้นขึ้นลง ยอด PV ของกลุ่มในหนึ่งเดือนปฏิทินซื้อเปอร์เซ็นต์ให้คุณ สเกลคลาสสิกของแอมเวย์เริ่มที่ 3% ที่ 200 PV แล้วไล่ 6% · 9% · 12% · 15% · 18% และ 21% ที่ 10,000 PV ขั้นเหล่านี้รีเซ็ตทุกเดือน เพราะระดับนี้ต้องทำใหม่ ไม่ใช่ได้แล้วได้เลย',
            '',
            '3 · ส่วนต่าง คุณได้เปอร์เซ็นต์ของตัวเอง ลบด้วยเปอร์เซ็นต์ที่สายนั้นได้ไปแล้ว ถ้าคุณอยู่ที่ 21% และสายหนึ่งทำได้ 15% คุณได้ส่วนต่าง 6% จาก BV ของสายนั้น นี่คือที่มาของคำว่าขั้นบันได คุณได้ค่าตอบแทนตามความสูงของขั้นระหว่างคุณกับคนข้างล่าง',
            '',
            '4 · การแยกสาย เมื่อสายใดขึ้นถึงขั้นสูงสุด สายนั้นจะแยกออก ยอดของเขาหยุดนับรวมเป็นยอดกลุ่มของคุณ และส่วนต่างจากสายนั้นสิ้นสุดลง สิ่งที่เข้ามาแทนคือโบนัสผู้นำจากสายนั้น และเมื่อคุณสูงขึ้นก็จะมีโบนัสที่ลงลึกกว่านั้นอีก นี่คือเหตุผลที่ตำแหน่งเหนือขั้นบันไดนับกันเป็น จำนวนสาย ไม่ใช่ยอดขาย เช่น สามสายที่ทำได้ หกสายที่ทำได้ ซึ่งแต่ละระดับก็มีชื่อเรียกของตัวเอง',
            '',
            'มีสองข้อที่ตามมาและควรจำไว้ อย่างแรก การแยกสายไม่ใช่การสูญเสีย แผนที่ลงโทษคุณเพราะสร้างผู้นำเก่งได้ ย่อมไม่มีใครยอมสร้างผู้นำ อย่างที่สอง แผนในตระกูลนี้จ่ายจากยอดขายสินค้า ไม่ได้จ่ายจากการที่มีคนสมัครเข้ามา ความต่างข้อนี้คือเส้นแบ่งระหว่างแผนการตลาดที่ถูกกฎหมายกับแชร์ลูกโซ่ และควรพูดให้ชัดได้',
            '',
            'ตัวเลขข้างต้นเป็นสเกลที่แอมเวย์ประเทศไทยเผยแพร่ ใช้ที่นี่เพราะเป็นแผนแบบนี้ที่เก่าแก่และมีเอกสารครบที่สุด แต่ละบริษัทกำหนดตัวเลขของตัวเอง แต่ละประเทศต่างกัน และมีการปรับเป็นระยะ ถ้าจะนำไปใช้จริง ให้อ่านแผนของธุรกิจที่คุณทำอยู่เป็นหลัก',
          ].join('\n'),
        },
      },
    },
  ],
  evidence: [
    {
      ingredient: 'magnesium',
      title: 'Magnesium — Fact Sheet for Health Professionals',
      source: 'NIH Office of Dietary Supplements',
      url: 'https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/',
      summary: 'Reference overview of dietary sources, intake levels, and interactions.',
    },
  ],
  brands: [
    { code: 'brand-a', name: 'Northline Naturals' },
    { code: 'brand-b', name: 'Verda Wellness' },
  ],
  products: [
    {
      code: 'northline-magnesium-glycinate',
      brand: 'brand-a',
      name: 'Magnesium Glycinate 200mg',
      description: 'A magnesium supplement in the glycinate form.',
      sourceUrl: 'https://example.com/northline/magnesium-glycinate',
      safetyNotes:
        'Follow the label. Not intended to diagnose, treat, cure, or prevent any disease.',
      ingredients: ['magnesium'],
    },
    {
      code: 'verda-magnesium-citrate',
      brand: 'brand-b',
      name: 'Magnesium Citrate 150mg',
      description: 'A magnesium supplement in the citrate form.',
      sourceUrl: 'https://example.com/verda/magnesium-citrate',
      safetyNotes:
        'Follow the label. Not intended to diagnose, treat, cure, or prevent any disease.',
      ingredients: ['magnesium'],
    },
    {
      code: 'verda-calm-blend',
      brand: 'brand-b',
      name: 'Evening Calm Blend',
      description: 'A blend containing L-theanine and magnesium.',
      sourceUrl: 'https://example.com/verda/evening-calm',
      safetyNotes:
        'Follow the label. Not intended to diagnose, treat, cure, or prevent any disease.',
      ingredients: ['l-theanine', 'magnesium'],
    },
  ],
};
