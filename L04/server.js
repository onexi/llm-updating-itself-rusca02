import express from 'express';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from "fs";
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(bodyParser.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.resolve(process.cwd(), './public')));

// ✅ OpenAI API configuration
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

let state = {
    chatgpt: false,
    assistant_id: "",
    assistant_name: "",
    dir_path: "",
    news_path: "",
    thread_id: "",
    user_message: "",
    run_id: "",
    run_status: "",
    vector_store_id: "",
    tools: [],
    parameters: []
};

// ✅ Load available function tools
async function getFunctions() {
    const files = fs.readdirSync(path.resolve(__dirname, "./functions"));
    const openAIFunctions = {};

    for (const file of files) {
        if (file.endsWith(".js")) {
            const moduleName = file.slice(0, -3);
            const modulePath = `./functions/${moduleName}.js`;
            const { details, execute } = await import(modulePath);

            openAIFunctions[moduleName] = { details, execute };
        }
    }
    return openAIFunctions;
}

// ✅ Save function if GPT generates a valid tool
function saveFunctionToFile(gptMessage) {
    const match = gptMessage.match(/const execute = async[^`]+export { execute, details }/s);
    if (!match) {
        console.log("❌ No valid function detected.");
        return;
    }

    const functionCode = match[0];
    const functionNameMatch = functionCode.match(/name:\s*'(\w+)'/);
    const functionName = functionNameMatch ? functionNameMatch[1] : "unknownFunction";

    const filePath = path.join(__dirname, 'functions', `${functionName}.js`);
    fs.writeFileSync(filePath, functionCode);
    console.log(`✅ Function saved: ${filePath}`);
}

// ✅ OpenAI Call with Function Handling
app.post('/api/openai-call', async (req, res) => {
    const { user_message } = req.body;

    console.log(`📨 User Message: ${user_message}`);

    const functions = await getFunctions();
    const availableFunctions = Object.values(functions).map(fn => fn.details);
    console.log(`🔎 Available Functions: ${JSON.stringify(availableFunctions)}`);

    let messages = [
        { role: 'system', content: 'You are a helpful assistant. If a requested function is missing, generate a JavaScript function using the OpenAI tool schema. DO NOT explain the code, just return the function in a valid JavaScript module format.' },
        { role: 'user', content: user_message }
    ];

    try {
        let response;
        if (availableFunctions.length > 0) {
            response = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages,
                tools: availableFunctions
            });
        } else {
            response = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages
            });
        }

        console.log(`🔍 GPT Response: ${JSON.stringify(response)}`);

        const toolCall = response.choices[0]?.message?.tool_calls?.[0];

        if (toolCall) {
            const functionName = toolCall.function.name;
            const parameters = JSON.parse(toolCall.function.arguments);

            if (functions[functionName]) {
                const result = await functions[functionName].execute(...Object.values(parameters));
                res.json({ message: JSON.stringify(result) });
            } else {
                res.json({ message: `⚠️ Function ${functionName} not found.` });
            }
        } else {
            const gptMessage = response.choices[0].message.content;
            if (gptMessage.includes("export { execute, details }")) {
                saveFunctionToFile(gptMessage);
                res.json({ message: "✅ Function created and saved!" });
            } else {
                res.json({ message: gptMessage });
            }
        }
    } catch (error) {
        console.error("❌ OpenAI API Error:", error);
        res.status(500).json({ error: 'OpenAI API failed', details: error.message });
    }
});

// ✅ Handle user input for prompt
app.post('/api/prompt', async (req, res) => {
    state = req.body;
    try {
        res.status(200).json({ message: `📝 Prompt Received: ${state.user_message}` });
    } catch (error) {
        console.error("❌ Prompt Processing Failed:", error);
        res.status(500).json({ message: 'User Message Failed' });
    }
});

// ✅ Start the server
const PORT = 3001;
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
