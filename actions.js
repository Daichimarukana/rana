// actions.js
// Rana が自律的に実行できるアクション定義

let apiBridge = {
    postUeuse: async (text) => null,
    fetchAgreedTimeline: async (limit) => [],
    searchAgreedUeuse: async (keyword, limit) => [],
    followAgreedUser: async (userId) => null
};

function setApiBridge(bridge) {
    apiBridge = { ...apiBridge, ...bridge };
}

const actions = {
    // 1. つぶやく
    uwuzu_post: {
        buildArg: (ctx) => {
            const cleanThought = ctx.thought.replace(/call:.*?\)/g, '').trim();
            if (!cleanThought || cleanThought.length < 2) {
                return null;
            }
            return cleanThought;
        },
        async execute(text, organism) {
            if (!text || typeof text !== 'string' || text.trim().length === 0) {
                console.log("[投稿スキップ] らなの言葉がまとまらなかったため見送りました。");
                return null;
            }

            organism.emit('action', { type: 'uwuzu_post', content: text });

            try {
                const res = await apiBridge.postUeuse(text);
                if (res && res.uniqid) {
                    console.log(`[投稿成功] ID: ${res.uniqid} 内容: "${text}"`);
                    organism.speechUrge = 0.0;
                    return { keyword: '投稿', learnedText: null };
                } else {
                    console.log("[投稿失敗] APIから正常なレスポンスが得られませんでした。");
                    return null;
                }
            } catch (err) {
                console.error("[投稿エラー]:", err.message);
                throw err;
            }
        }
    },

    // 2. TL閲覧
    uwuzu_read: {
        argType: 'none',
        buildArg: () => '',
        async execute(_, organism) {
            organism.emit('action', { type: 'uwuzu_read' });
            console.log("[閲覧] タイムラインを確認中...");

            try {
                const agreedPosts = await apiBridge.fetchAgreedTimeline(30);

                if (!agreedPosts || agreedPosts.length === 0) {
                    console.log("[閲覧スキップ] 同意済みユーザーの新しい投稿がなかったため、学習を見送りました。");
                    return null;
                }

                const selectedPost = agreedPosts[Math.floor(Math.random() * agreedPosts.length)];
                const cleanText = selectedPost.text
                    .replace(/@\w+\s?/g, '')
                    .replace(/https?:\/\/\S+/g, '')
                    .trim();

                if (!cleanText || cleanText.length < 2) {
                    console.log("[閲覧スキップ] 有効なテキストがなかったため、学習を見送りました。");
                    return null;
                }

                const nouns = organism.filterNouns(cleanText);
                const keyword = nouns.length > 0 ? nouns[0] : cleanText.slice(0, 8);

                console.log(`[学習] 同意ユーザー(@${selectedPost.account.userid})のユーズを観測: "${cleanText}" (キーワード: ${keyword})`);

                return {
                    keyword: keyword,
                    learnedText: cleanText
                };
            } catch (err) {
                console.error("[閲覧エラー]:", err.message);
                throw err;
            }
        }
    },

    // 3. 検索&学習
    uwuzu_search: {
        buildArg: (ctx) => {
            return ctx.prominentNoun || ctx.target || '日常';
        },
        async execute(query, organism) {
            organism.emit('action', { type: 'uwuzu_search', query });
            console.log(`[uwuzu検索] 「${query}」に関する投稿を検索中...`);

            try {
                const matchedPosts = await apiBridge.searchAgreedUeuse(query, 20);

                if (!matchedPosts || matchedPosts.length === 0) {
                    console.log(`[検索スキップ] 「${query}」に関する同意ユーザーの投稿がなかったため、学習を見送りました。`);
                    return null;
                }

                const selectedPost = matchedPosts[Math.floor(Math.random() * matchedPosts.length)];
                const cleanText = selectedPost.text
                    .replace(/@\w+\s?/g, '')
                    .replace(/https?:\/\/\S+/g, '')
                    .trim();

                if (!cleanText || cleanText.length < 2) {
                    console.log(`[検索スキップ] 「${query}」の投稿テキストが短すぎるため、学習を見送りました。`);
                    return null;
                }

                console.log(`[検索学習] 「${query}」に関連するユーズを観測: "${cleanText}"`);

                return {
                    keyword: query,
                    learnedText: cleanText
                };
            } catch (err) {
                console.error("[uwuzu検索エラー]:", err.message);
                throw err;
            }
        }
    },

    // 4. ユーザーフォロー
    uwuzu_follow: {
        buildArg: (ctx) => {
            return ctx.prominentId || null;
        },
        async execute(targetUserId, organism) {
            if (!targetUserId || typeof targetUserId !== 'string' || targetUserId.trim().length === 0) {
                console.log(`[フォロースキップ] フォロー対象のユーザーIDが不明なため見送りました。(${targetUserId})`);
                return null;
            }

            organism.emit('action', { type: 'uwuzu_follow', target: targetUserId });
            console.log(`[フォロー試行] ユーザー「${targetUserId}」をフォローします...`);

            try {
                const res = await apiBridge.followAgreedUser(targetUserId);

                if (res && res.success) {
                    console.log(`[フォロー成功] ${targetUserId} をフォローしました！`);

                    return {
                        keyword: 'フォロー',
                        learnedText: null
                    };
                } else {
                    return null;
                }
            } catch (err) {
                console.error("[フォローエラー]:", err.message);
                throw err;
            }
        }
    }
};

const actionSeeds = [
    { question: "つぶやく", actionDSL: 'ユーズしようかな call:uwuzu_post()' },
    { question: "投稿", actionDSL: '上げちゃう？ call:uwuzu_post()' },
    { question: "暇", actionDSL: 'ひまー call:uwuzu_read()' },
    { question: "タイムライン", actionDSL: 'タイムライン見てみますかー call:uwuzu_read()' },
    { question: "調べる", actionDSL: 'なにこれ？ call:uwuzu_search("気になること")' },
    { question: "退屈", actionDSL: '面白いことないかなぁ。call:uwuzu_search("日常")' },
    { question: "フォローして", actionDSL: 'りょー call:uwuzu_follow("")' },
    { question: "フォローよろ", actionDSL: 'フォローしとくねー call:uwuzu_follow("")' }
];

module.exports = {
    actions,
    actionSeeds,
    setApiBridge,
    getActionNames: () => Object.keys(actions)
};