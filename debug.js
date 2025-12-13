// ほぼAI生成です。許せ～～～～～
const rana = require('./core.js');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(prompt) {
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            resolve(answer);
        });
    });
}

/**
 * メインの対話ループ
 */
async function main() {
    console.log("--- 対話・学習CLIツールへようこそ ---");
    console.log("   質問を入力してください。'exit'で終了、'cancel'で学習モードを中止、'rnd'でランダム生成(つぶやき)ができます。");
    console.log("-------------------------------------------");

    while (true) {
        const cleanedText = await askQuestion("\n> あなたの質問: ");

        if (cleanedText.toLowerCase() === 'exit') {
            console.log("ツールを終了します。");
            rl.close();
            break;
        }

        if (cleanedText.trim() === '') {
            continue;
        }

        if(cleanedText == "rnd"){
            console.log(rana.generateRandomText());
            continue;
        }

        const replyText = await rana.generateInputText(cleanedText);
        console.log(`\nらなの返答: ${replyText}`);

        const failureMessage = "ごめんなさい...よくわかりませんでした...";
        if (replyText === failureMessage) {
            console.log("\n適切な回答が記憶になかったため、学習モードに入ります。");
            console.log("理想的な回答を入力してください。");

            let studyMode = true;
            while (studyMode) {
                const idealAnswer = await askQuestion("理想的な回答 (または 'cancel'で中止): ");

                if (idealAnswer.toLowerCase() === 'cancel') {
                    console.log("学習モードを中止しました。通常の対話に戻ります。");
                    studyMode = false; // ループを抜ける
                } else if (idealAnswer.trim() !== '') {
                    try {
                        console.log(await rana.studyInputText(cleanedText, idealAnswer));
                        studyMode = false;
                    } catch (error) {
                        console.error("学習処理中にエラーが発生しました:", error);
                        console.log("再度理想的な回答を入力してください。または'cancel'で中止します。");
                    }
                }
            }
        }
    }
}

rana.init().then(() => {
    main().catch(error => {
        console.error("致命的なエラーが発生しました:", error);
        rl.close();
    });
}).catch(err => {
    console.error("Initialization failed:", err);
});

rl.on('close', () => {
    process.exit(0);
});