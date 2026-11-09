// 素のAI生成 許せ～～～～～
const readline = require('readline');
const RanaOrganism = require('./core.js');

async function main() {
    const rana = new RanaOrganism(undefined, true);
    await rana.init();

    // 1. 各種イベントのリスナー登録
    rana.on('speak', (text) => {
        console.log(`\n🗣️ [Ranaの独り言]: ${text}`);
    });

    rana.on('action', (act) => {
        console.log(`\n⚡ [Ranaが行動しました]: ${act.type} (引数: ${act.query || 'なし'})`);
    });

    rana.on('action_failed', (fail) => {
        console.log(`\n❓ [Ranaが困惑]: 存在しない行動「${fail.action}」をやろうとして失敗しました`);
    });

    rana.on('sleep', () => {
        console.log('\n🌙 [Rana]: ぐぅ……（眠りにつきました）');
    });

    rana.on('wake', (data) => {
        console.log(`\n☀️ [Rana]: はっ、起きた！（夢の焦点: ${data.focus.join(', ')}）`);
    });

    rana.on('learn', (data) => {
        console.log(`\n📚 [学習]: 「${data.question}」→「${data.answer}」を記憶しました`);
    });

    // 2. 思考ストリームをバックグラウンドで開始（ノンブロッキング）
    rana.start();

    // 3. コンソールからいつでも割り込んで話しかけられるようにする
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log("何か話しかけてみてください（Enterで送信 / そのままでも勝手に考えます）:");

    rl.on('line', async (line) => {
        if (!line.trim()) return;
        const reply = await rana.interact(line, 'cli_user');
        console.log(`[Ranaの返答]: ${reply}`);
    });
}

main();