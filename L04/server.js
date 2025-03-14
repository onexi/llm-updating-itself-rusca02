import express from 'express';
import bodyParser from 'body-parser';
import { OpenAI } from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from "fs";
import dotenv from 'dotenv';
dotenv.config();

// Initialize Express server
const app = express();
app.use(bodyParser.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.resolve(process.cwd(), './public')));

// OpenAI API configuration
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

// Function to load all available tools (functions)
async function getFunctions() {
    const files = fs.readdirSync(path.resolve(process.cwd(), "./functions"));
    const openAIFunctions = {};

    for (const file of files) {
        if (file.endsWith(".js")) {
            const moduleName = file.slice(0, -3);
            const modulePath = `./functions/${moduleName}.js`;
            const { details, execute } = await import(modulePath);

            openAIFunctions[moduleName] = {
                "details": details,
                "execute": execute
            };
        }
    }
    return openAIFunctions;
}

// Route to execute a function
app.post('/api/execute-function', async (req, res) => {
    const { functionName, parameters } = req.body;

    const functions = await getFunctions();

    if (!functions[functionName]) {
        return res.status(404).json({ error: 'Function not found' });
    }

    try {
        const result = await functions[functionName].execute(...Object.values(parameters));
        console.log(`result: ${JSON.stringify(result)}`);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Function execution failed', details: err.message });
    }
});

// 🔴 NEW CODE - Utility function to save generated functions
function saveFunctionToFile(gptMessage) {
    const match = gptMessage.match(/const execute = async[^`]+export { execute, details }/s);
    if (!match) {
        console.log("❌ No valid function detected in GPT response.");
        return;
    }

    const functionCode = match[0];
    const functionNameMatch = functionCode.match(/name:\s*'(\w+)'/);
    const functionName = functionNameMatch ? functionNameMatch[1] : "unknownFunction";

    const filePath = path.join(__dirname, 'functions', `${functionName}.js`);
    fs.writeFileSync(filePath, functionCode);
    console.log(`✅ Function saved: ${filePath}`);
}

// 🔴 NEW CODE - Updated GPT API Call with Function Generation Logic
app.post('/api/openai-call', async (req, res) => {
    const { user_message } = req.body;

    const functions = await getFunctions();
    const availableFunctions = Object.values(functions).map(fn => fn.details);
    console.log(`Available Functions: ${JSON.stringify(availableFunctions)}`);

    let messages = [
        { role: 'system', content: 'You are a helpful assistant. If the user requests a function that does not exist, generate a JavaScript function using the OpenAI tool schema. DO NOT explain the code, just return the function in a valid JavaScript module format.' },
        { role: 'user', content: user_message }
    ];

    try {
        let response;
        if (availableFunctions.length > 0) {
            response = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: messages,
                tools: availableFunctions
            });
        } else {
            messages.push({ role: 'system', content: 'Ensure your response includes a JavaScript function following the OpenAI tool schema.' });
            response = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: messages
            });
        }

        console.log(`🔍 GPT Response: ${JSON.stringify(response)}`);

        const toolCall = response.choices[0]?.message?.tool_calls?.[0];

        if (toolCall) {
            const functionName = toolCall.function.name;
            const parameters = JSON.parse(toolCall.function.arguments);

            const result = await functions[functionName].execute(...Object.values(parameters));
            const function_call_result_message = {
                role: "tool",
                content: JSON.stringify({ result }),
                tool_call_id: toolCall.id
            };

            messages.push(response.choices[0].message);
            messages.push(function_call_result_message);

            const final_response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
            });

            let output = final_response.choices[0]?.message?.content || "No content returned.";
            res.json({ message: output, state: state });
        } else {
            const gptMessage = response.choices[0].message.content;
            if (gptMessage.includes("export { execute, details }")) {
                saveFunctionToFile(gptMessage);
                res.json({ message: "Function created and saved!", state: state });
            } else {
                res.json({ message: gptMessage });
            }
        }

    } catch (error) {
        res.status(500).json({ error: 'OpenAI API failed', details: error.message });
    }
});

// Route to handle user input
app.post('/api/prompt', async (req, res) => {
    state = req.body;
    try {
        res.status(200).json({ message: `Got prompt: ${state.user_message}`, state: state });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: 'User Message Failed', state: state });
    }
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});
