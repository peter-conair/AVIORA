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
