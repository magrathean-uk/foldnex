// Probe fixtures: two hand-written windows. Each row is
// [title, url, gold category key, gold task]. A null task means "no real
// group": those tabs are left out of the pairwise score.
// Written before any result was seen. No social sites (Socials is a locked
// rule group and would only add noise here).

export const WINDOWS = {
  dev: [
    ['northwind-labs/tabsort: Tab organiser for Chrome', 'https://github.com/northwind-labs/tabsort', 'dev', 'Tabsort extension'],
    ['Pull requests · northwind-labs/tabsort', 'https://github.com/northwind-labs/tabsort/pulls', 'dev', 'Tabsort extension'],
    ['Issues · northwind-labs/tabsort', 'https://github.com/northwind-labs/tabsort/issues', 'dev', 'Tabsort extension'],
    ['chrome.tabGroups | API | Chrome for Developers', 'https://developer.chrome.com/docs/extensions/reference/api/tabGroups', 'dev', 'Tabsort extension'],
    ['The extension service worker lifecycle | Chrome for Developers', 'https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle', 'dev', 'Tabsort extension'],
    ['The Prompt API | AI on Chrome | Chrome for Developers', 'https://developer.chrome.com/docs/ai/prompt-api', 'dev', 'Tabsort extension'],
    ['Tabsort - Tab Organizer - Chrome Web Store', 'https://chromewebstore.google.com/detail/tabsort/abcdefghijklmnopabcdefghijklmnop', 'dev', 'Tabsort extension'],
    ['Developer Dashboard - Chrome Web Store', 'https://chrome.google.com/webstore/devconsole', 'dev', 'Tabsort extension'],
    ['Manifest - Content Security Policy | Chrome for Developers', 'https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy', 'dev', 'Tabsort extension'],

    ['Cloud Console · Hetzner', 'https://console.hetzner.cloud/projects/123456/servers', 'infra', 'WireGuard VPS'],
    ['Quick Start - WireGuard', 'https://www.wireguard.com/quickstart/', 'infra', 'WireGuard VPS'],
    ['How To Set Up WireGuard on Ubuntu 24.04 | DigitalOcean', 'https://www.digitalocean.com/community/tutorials/how-to-set-up-wireguard-on-ubuntu', 'infra', 'WireGuard VPS'],
    ['networking - WireGuard handshake completes but no traffic passes - Server Fault', 'https://serverfault.com/questions/1099999/wireguard-handshake-completes-but-no-traffic', 'infra', 'WireGuard VPS'],
    ['UFW - Community Help Wiki', 'https://help.ubuntu.com/community/UFW', 'infra', 'WireGuard VPS'],
    ['Simple ruleset for a server - nftables wiki', 'https://wiki.nftables.org/wiki-nftables/index.php/Simple_ruleset_for_a_server', 'infra', 'WireGuard VPS'],
    ['unbound.conf(5) — Unbound documentation', 'https://unbound.docs.nlnetlabs.nl/en/latest/manpages/unbound.conf.html', 'infra', 'WireGuard VPS'],
    ['Finding the right MTU for a WireGuard tunnel | Kerem\'s blog', 'https://keremerkan.net/posts/wireguard-mtu-fixes/', 'infra', 'WireGuard VPS'],

    ['Prompt caching - Claude Docs', 'https://docs.claude.com/en/docs/build-with-claude/prompt-caching', 'ai', 'LLM APIs'],
    ['Claude Console', 'https://console.anthropic.com/settings/keys', 'ai', 'LLM APIs'],
    ['Prompt caching | OpenAI API', 'https://developers.openai.com/api/docs/guides/prompt-caching', 'ai', 'LLM APIs'],
    ['Pricing | OpenAI API', 'https://developers.openai.com/api/docs/pricing', 'ai', 'LLM APIs'],
    ['Models | OpenRouter', 'https://openrouter.ai/models', 'ai', 'LLM APIs'],
    ['GroqCloud Console - Playground', 'https://console.groq.com/playground', 'ai', 'LLM APIs'],
    ['minishlab/potion-base-8M · Hugging Face', 'https://huggingface.co/minishlab/potion-base-8M', 'ai', 'LLM APIs'],
    ['MinishLab/model2vec: Fast State-of-the-Art Static Embeddings', 'https://github.com/MinishLab/model2vec', 'ai', 'LLM APIs'],
    ['Structured outputs | OpenAI API', 'https://developers.openai.com/api/docs/guides/structured-outputs', 'ai', 'LLM APIs'],

    ['Concurrency | Documentation - The Swift Programming Language', 'https://docs.swift.org/swift-book/documentation/the-swift-programming-language/concurrency/', 'dev', 'iOS app'],
    ['App Store Connect', 'https://appstoreconnect.apple.com/apps', 'dev', 'iOS app'],
    ['TestFlight - Apple Developer', 'https://developer.apple.com/testflight/', 'dev', 'iOS app'],
    ['Sendable and actor isolation question - Using Swift - Swift Forums', 'https://forums.swift.org/t/sendable-and-actor-isolation/71234', 'dev', 'iOS app'],
    ['How to use @MainActor to run code on the main queue - Hacking with Swift', 'https://www.hackingwithswift.com/quick-start/concurrency/how-to-use-mainactor', 'dev', 'iOS app'],
    ['Configuring your first Xcode Cloud workflow | Apple Developer Documentation', 'https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow', 'dev', 'iOS app'],
    ['SwiftData | Apple Developer Documentation', 'https://developer.apple.com/documentation/swiftdata', 'dev', 'iOS app'],

    ['Inbox (14) - sam@example.com - Gmail', 'https://mail.google.com/mail/u/0/#inbox', 'mail', 'Email & calendar'],
    ['Mail - Sam Carter - Outlook', 'https://outlook.office.com/mail/', 'mail', 'Email & calendar'],
    ['Google Calendar - Week of 22 November 2026', 'https://calendar.google.com/calendar/u/0/r/week', 'office', 'Email & calendar'],
    ['Inbox | Proton Mail', 'https://mail.proton.me/u/0/inbox', 'mail', 'Email & calendar'],
    ['Meet - Weekly sync', 'https://meet.google.com/abc-defg-hij', 'office', 'Email & calendar'],

    ['BBC News - Home', 'https://www.bbc.co.uk/news', 'news', 'News'],
    ['Budget 2026: what the chancellor announced | The Guardian', 'https://www.theguardian.com/uk-news/2026/nov/20/budget-2026-what-the-chancellor-announced', 'news', 'News'],
    ['Hacker News', 'https://news.ycombinator.com/', 'news', 'News'],
    ['Chrome 154 arrives with on-device AI changes | Ars Technica', 'https://arstechnica.com/gadgets/2026/11/chrome-154-on-device-ai/', 'news', 'News'],
    ['Datacentre outage takes down UK bank apps • The Register', 'https://www.theregister.com/2026/11/21/datacentre_outage_uk_banks/', 'news', 'News'],

    ['Buy MacBook Pro - Apple (UK)', 'https://www.apple.com/uk/shop/buy-mac/macbook-pro', 'shop', 'MacBook purchase'],
    ['MacBook Pro 16-inch M5 Max review: absurdly fast | The Verge', 'https://www.theverge.com/reviews/macbook-pro-16-m5-max-review', 'shop', 'MacBook purchase'],
    ['Apple MacBook Pro 16 M5 Pro 2026 - Amazon.co.uk', 'https://www.amazon.co.uk/dp/B0EXAMPLE12', 'shop', 'MacBook purchase'],
    ['MacBook Pro M5 vs M4: Should you upgrade? - YouTube', 'https://www.youtube.com/watch?v=abc123def45', 'shop', 'MacBook purchase'],
    ['Apple MacBook Pro 16" M5 Pro price comparison - PriceSpy UK', 'https://pricespy.co.uk/product.php?p=1234567', 'shop', 'MacBook purchase'],
    ['Apple Trade In - Apple (UK)', 'https://www.apple.com/uk/shop/trade-in', 'shop', 'MacBook purchase'],

    ['Self Assessment tax return - GOV.UK', 'https://www.gov.uk/self-assessment-tax-returns', 'money', 'Company admin'],
    ['NORTHWIND LABS LTD overview - Find and update company information - GOV.UK', 'https://find-and-update.company-information.service.gov.uk/company/12345678', 'admin', 'Company admin'],
    ['Invoices | Xero', 'https://go.xero.com/app/invoicing', 'money', 'Company admin'],
    ['Business account - Monzo', 'https://web.monzo.com/accounts', 'money', 'Company admin'],
    ['VAT Returns - GOV.UK', 'https://www.gov.uk/submit-vat-return', 'money', 'Company admin'],
    ['File your confirmation statement - GOV.UK', 'https://www.gov.uk/file-your-confirmation-statement-with-companies-house', 'admin', 'Company admin'],

    ['lofi hip hop radio - beats to relax/study to - YouTube', 'https://www.youtube.com/watch?v=jfKfPfyJRdk', 'video', 'Music & TV'],
    ['Spotify - Web Player', 'https://open.spotify.com/', 'video', 'Music & TV'],
    ['Home - Netflix', 'https://www.netflix.com/browse', 'video', 'Music & TV'],
    ['Severance - Apple TV+', 'https://tv.apple.com/gb/show/severance/umc.cmc.1srk2goyh2q2zdxcx605w8vtx', 'video', 'Music & TV'],

    ['Kalman filter - Wikipedia', 'https://en.wikipedia.org/wiki/Kalman_filter', 'learn', null],
    ['London weather - Met Office', 'https://www.metoffice.gov.uk/weather/forecast/gcpvj0v07', 'news', null],
    ['London to Cambridge - Google Maps', 'https://www.google.com/maps/dir/London/Cambridge', 'travel', null],
    ['Speedtest by Ookla - The Global Broadband Speed Test', 'https://www.speedtest.net/', 'infra', null]
  ],

  life: [
    ['Cheap flights from London to Tokyo | Skyscanner', 'https://www.skyscanner.net/transport/flights/lond/tyoa/', 'travel', 'Japan trip'],
    ['Hotels in Kyoto, Japan - Booking.com', 'https://www.booking.com/city/jp/kyoto.html', 'travel', 'Japan trip'],
    ['Japan Rail Pass | JAPAN RAIL PASS official site', 'https://japanrailpass.net/en/', 'travel', 'Japan trip'],
    ['Kyoto 3-day itinerary - japan-guide.com', 'https://www.japan-guide.com/e/e3950_3days.html', 'travel', 'Japan trip'],
    ['Tokyo to Kyoto - Google Maps', 'https://www.google.com/maps/dir/Tokyo/Kyoto', 'travel', 'Japan trip'],
    ['10 Days in Japan: Tokyo, Kyoto & Osaka travel vlog - YouTube', 'https://www.youtube.com/watch?v=jp10days001', 'travel', 'Japan trip'],
    ['THE 10 BEST Ramen in Tokyo - Tripadvisor', 'https://www.tripadvisor.co.uk/Restaurants-g298184-c33-Tokyo.html', 'food', 'Japan trip'],
    ['Cherry blossom forecast 2027 - when to see sakura in Japan', 'https://www.japan-guide.com/sakura/', 'travel', 'Japan trip'],
    ['Japan travel advice - GOV.UK', 'https://www.gov.uk/foreign-travel-advice/japan', 'travel', 'Japan trip'],
    ['1 GBP to JPY - British Pounds to Japanese Yen Exchange Rate - Xe', 'https://www.xe.com/currencyconverter/convert/?Amount=1&From=GBP&To=JPY', 'money', 'Japan trip'],

    ['Kitchen Planner - Design your dream kitchen - IKEA', 'https://www.ikea.com/gb/en/planners/kitchen-planner/', 'home', 'Kitchen renovation'],
    ['Kitchen Worktops | Laminate & Solid Wood | Wickes', 'https://www.wickes.co.uk/Products/Kitchens/Worktops/c/1000761', 'home', 'Kitchen renovation'],
    ['75 Small Kitchen Ideas You\'ll Love - Houzz', 'https://www.houzz.co.uk/photos/small-kitchen-ideas-phbr1-bp~t_10009~a_30-190', 'home', 'Kitchen renovation'],
    ['How to Tile a Kitchen Splashback | DIY for beginners - YouTube', 'https://www.youtube.com/watch?v=tile0splash1', 'home', 'Kitchen renovation'],
    ['Kitchen Wall Tiles | Tiles | B&Q', 'https://www.diy.com/departments/tiling/kitchen-wall-tiles/DIY1616161.cat', 'home', 'Kitchen renovation'],
    ['Kitchen Fitters in Cambridge | Checkatrade', 'https://www.checkatrade.com/Search/Kitchen-Fitter/in/Cambridge', 'home', 'Kitchen renovation'],
    ['How much does a new kitchen cost in 2026? - Which?', 'https://www.which.co.uk/reviews/fitted-kitchens/article/kitchen-costs-aO2Vd0X1sT3k', 'home', 'Kitchen renovation'],

    ['Easy chicken curry recipe | BBC Good Food', 'https://www.bbcgoodfood.com/recipes/easy-chicken-curry', 'food', 'Recipes'],
    ['Foolproof Pan Pizza Recipe - Serious Eats', 'https://www.seriouseats.com/foolproof-pan-pizza-recipe', 'food', 'Recipes'],
    ['Gulyásleves recept | Nosalty', 'https://www.nosalty.hu/recept/gulyasleves', 'food', 'Recipes'],
    ['Käsespätzle - das Originalrezept | Chefkoch', 'https://www.chefkoch.de/rezepte/1062121211526182/Kaesespaetzle.html', 'food', 'Recipes'],
    ['The Perfect Sourdough Bread, step by step - YouTube', 'https://www.youtube.com/watch?v=sourdough222', 'food', 'Recipes'],
    ['Shakshuka Recipe - NYT Cooking', 'https://cooking.nytimes.com/recipes/1014721-shakshuka-with-feta', 'food', 'Recipes'],

    ['Dashboard | Strava', 'https://www.strava.com/dashboard', 'health', 'Running'],
    ['Garmin Connect', 'https://connect.garmin.com/modern/', 'health', 'Running'],
    ['16-week marathon training plan for beginners - Runner\'s World', 'https://www.runnersworld.com/uk/training/marathon/a760067/16-week-marathon-training-plan/', 'health', 'Running'],
    ['Couch to 5K: week by week - NHS', 'https://www.nhs.uk/live-well/exercise/running-and-aerobic-exercises/couch-to-5k-week-by-week/', 'health', 'Running'],
    ['Nike Pegasus 42 Men\'s Road Running Shoes - Amazon.co.uk', 'https://www.amazon.co.uk/dp/B0RUNSHOE42', 'shop', 'Running'],
    ['Best running shoes 2026: tested and reviewed | RunRepeat', 'https://runrepeat.com/guides/best-running-shoes', 'shop', 'Running'],
    ['London Marathon 2027 ballot results - TCS London Marathon', 'https://www.londonmarathonevents.co.uk/london-marathon/ballot', 'sport', 'Running'],

    ['Senior Platform Engineer jobs in London - Indeed', 'https://uk.indeed.com/jobs?q=senior+platform+engineer&l=London', 'jobs', 'Job search'],
    ['Staff Engineer salaries in London - Glassdoor', 'https://www.glassdoor.co.uk/Salaries/london-staff-engineer-salary-SRCH_IL.0,6_IM1035_KO7,21.htm', 'jobs', 'Job search'],
    ['Careers at Monzo - open roles', 'https://monzo.com/careers', 'jobs', 'Job search'],
    ['CV 2026 - Google Docs', 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit', 'jobs', 'Job search'],
    ['How to prepare for a system design interview - The Pragmatic Engineer', 'https://newsletter.pragmaticengineer.com/p/system-design-interview-prep', 'jobs', 'Job search'],
    ['Platform Engineer - Wise - Welcome to the Jungle', 'https://www.welcometothejungle.com/en/companies/wise/jobs/platform-engineer_london', 'jobs', 'Job search'],

    ['BBC News - Home', 'https://www.bbc.co.uk/news', 'news', 'News'],
    ['UK interest rates held at 3.75% | The Guardian', 'https://www.theguardian.com/business/2026/nov/19/bank-of-england-interest-rates-held', 'news', 'News'],
    ['Telex: Friss hírek', 'https://telex.hu/', 'news', 'News'],
    ['DER SPIEGEL | Online-Nachrichten', 'https://www.spiegel.de/', 'news', 'News'],
    ['Markets wrap: stocks slide as tech earnings disappoint - Financial Times', 'https://www.ft.com/content/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d', 'news', 'News'],

    ['Monzo - Personal account', 'https://web.monzo.com/accounts/personal', 'money', 'Bills & banking'],
    ['Your energy bill - Octopus Energy', 'https://octopus.energy/dashboard/new/accounts/A-1B2C3D4E/bills', 'money', 'Bills & banking'],
    ['Pay your Council Tax - Cambridge City Council', 'https://www.cambridge.gov.uk/pay-your-council-tax', 'money', 'Bills & banking'],
    ['Stocks and Shares ISA | Vanguard UK Investor', 'https://www.vanguardinvestor.co.uk/investing-explained/stocks-shares-isa', 'money', 'Bills & banking'],
    ['Self Assessment: pay your tax bill - GOV.UK', 'https://www.gov.uk/pay-self-assessment-tax-bill', 'money', 'Bills & banking'],
    ['Home insurance renewal quote - Aviva', 'https://www.aviva.co.uk/insurance/home-products/home-insurance/renewal/', 'money', 'Bills & banking'],

    ['Design Your Model Y | Tesla United Kingdom', 'https://www.tesla.com/en_gb/modely/design', 'cars', 'Car'],
    ['Used Tesla Model Y cars for sale | Auto Trader UK', 'https://www.autotrader.co.uk/cars/used/tesla/model-y', 'cars', 'Car'],
    ['Tesla Model Y review 2026 | What Car?', 'https://www.whatcar.com/tesla/model-y/estate/review/n22963', 'cars', 'Car'],
    ['Compare car insurance quotes - Compare the Market', 'https://www.comparethemarket.com/car-insurance/', 'money', 'Car'],
    ['2026 Tesla Model Y Juniper: 6 months later - YouTube', 'https://www.youtube.com/watch?v=modely6mth', 'cars', 'Car'],
    ['Home charger installation - Pod Point', 'https://pod-point.com/products/driver/solo-3s', 'cars', 'Car'],

    ['Home - Netflix', 'https://www.netflix.com/browse', 'video', 'Entertainment'],
    ['Discover Weekly - Spotify', 'https://open.spotify.com/playlist/37i9dQZEVXcJZyENOWUFo7', 'video', 'Entertainment'],
    ['BBC iPlayer - Home', 'https://www.bbc.co.uk/iplayer', 'video', 'Entertainment'],
    ['Slow Horses - Apple TV+', 'https://tv.apple.com/gb/show/slow-horses/umc.cmc.2szz3fdt71tl1ulnbp8utgq5o', 'video', 'Entertainment'],
    ['Jazz for a rainy evening - YouTube', 'https://www.youtube.com/watch?v=jazzrain0001', 'video', 'Entertainment'],

    ['Photosynthesis - Wikipedia', 'https://en.wikipedia.org/wiki/Photosynthesis', 'learn', null],
    ['Google Translate', 'https://translate.google.com/?sl=hu&tl=en', 'learn', null],
    ['Cambridge weather - Met Office', 'https://www.metoffice.gov.uk/weather/forecast/u1214b469', 'news', null],
    ['Track your item - Royal Mail', 'https://www.royalmail.com/track-your-item', 'shop', null]
  ]
};
