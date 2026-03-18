//ENV
require("@dotenvx/dotenvx").config();
//Server
const express = require("express");
const xlsx = require("xlsx");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const port = process.env.PORT || 3000;


//twilio 
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
console.log("SID loaded:", !!process.env.TWILIO_ACCOUNT_SID);
console.log("Token loaded:", !!process.env.TWILIO_AUTH_TOKEN);
const Voice = require("twilio/lib/rest/Voice");
const VoiceResponse =  require("twilio").twiml.VoiceResponse;
const speaker = "Polly.Joanna";
const language = "en-GB";

//AI
const {GoogleGenAI } = require("@google/genai");
const z  = require("zod");
//const { zodToJsonSchema } = require("zod-to-json-schema");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({apiKey: GEMINI_API_KEY});


const client = require('twilio')(accountSid, authToken,{
    //region: "IE1",
    //edge: "london",
    logLevel: "debug"
});


//MENU
const MENU_DATA = createMenuJSON();
const ALLERGEN_DATA = null; // TODO

// ROUTES
app.get("/", (req, res) => {
  res.send("hi");
});


app.post("/voice/incoming", (req, res) => {
    const  callSid = req.body.CallSid;
    const callerNumber = req.body.From || "anonymous";

    console.log("Received incoming call from " + callerNumber + " (SID: " + callSid + ")");
    
    getOrCreateSession(callSid, callerNumber);
    
    const twiml = new VoiceResponse();

    // Start the gather loop immediately upon answering
    const gather = twiml.gather({
        input: "speech",
        action: "/voice/process",
        speechTimeout: "auto",
    });

    gather.say({ voice: speaker, language: language }, "Thank you for calling our restaurant. What can I get for you today?");
    
    res.type("text/xml");
    res.send(twiml.toString());

    //console.log("Menu: ", MENU_DATA);

});

app.post("/voice/process", async (req, res) => {
    const  callSid = req.body.CallSid;
    const callerNumber = req.body.From || "anonymous"; 
    console.log("gathering info from " + callerNumber + " (SID: " + callSid + ")");

    // get text from speech recognition and add to conversation history
    const userSpeech = req.body.SpeechResult || "";
    const session = getOrCreateSession(callSid, callerNumber);

    console.log("############");
    console.log("User said: ", userSpeech);
    console.log("############");

    if (userSpeech) {
      session.conversationHistory.push({ role: "user", parts: [{ text: userSpeech }] });
    }

    // query ai for response
    const [action, items, AIresponse] = await queryAI(session.conversationHistory);
    session.conversationHistory.push({ role: "model", parts: [{ text: AIresponse }] });
    
    console.log("############");
    console.log("AI responded: ", AIresponse);
    console.log("############");

    //build and send twiml response based on AI response
    const twiml = new VoiceResponse();
    const gather = twiml.gather({
        input: "speech",
        action: "/voice/process",
        speechTimeout: "auto",
    });

    gather.say( { voice: speaker, language: language },AIresponse);

    res.type("text/xml");
    res.send(twiml.toString());

    console.log("############");
    console.log("Conversation History: ", session.conversationHistory);
    console.log("############");

    await decideAction(action, items, session);
    twiml.redirect("/voice/process");


});


//send SMS of payment link (might want to include payment amount and order details in the future)
app.post("/payment-link", async (req, res) => {
    const { customerPhone, paymentLink } = req.body;

    try {
        await client.messages.create({
            body: `Your payment link is: ${paymentLink}`,
            from: process.env.PHONE_NUMBER,
            to: customerPhone
        });
        res.status(200).send("Payment link sent");
    } catch (error) {
        console.error("Error sending payment link:", error);
        res.status(500).send("Error sending payment link");
    }
});

// send SMS of order confirmation
app.post("/order-confirmed", async (req, res) => {
    const { orderId, callerNumber, items, total } = req.body;

    try {
        await client.messages.create({
            body: `Your order ${orderId} has been confirmed. Total: ${total}. Items: ${items.join(", ")}`,
            from: process.env.PHONE_NUMBER,
            to: callerNumber
        });
        res.status(200).send("Order confirmation sent");
    } catch (error) {
        console.error("Error sending order confirmation:", error);
        res.status(500).send("Error sending order confirmation");
    }
});


//END OF ROUTES
// Start server
app.listen(port, () => {
    console.log(`starting server at  http://localhost:${port}`);
})



//HELPER FUNCTIONS
const sessions = new Map();

//SESSIONS
// ── Create / retrieve a session for a caller ──────────
function getOrCreateSession(callSid, callerNumber) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      id: uuidv4(),
      callSid,
      callerNumber,
      items: [],          // { item, quantity }
      status: "ordering", // ordering | confirmed | cancelled
      createdAt: new Date(),
      conversationHistory: [], //  message history
    });
  }
  return sessions.get(callSid);
}

//ACTIONS
async function decideAction(action, items, session) {
  //"ADD_ITEM", "REMOVE_ITEM", "SHOW_ORDER", "CONFIRM_ORDER", "CANCEL_ORDER", "REPEAT_MENU", "UNKNOWN"
    switch(action){
        case "ADD_ITEM":
            items.forEach(item => {
                addItemToSession(session.callSid, item.Name, item.quantity);
            });
            break;
        case "REMOVE_ITEM":
            items.forEach(item => {
                removeItemFromSession(session.callSid, item.Name);
            });
            break;
        case "SHOW_ORDER":
            // no action needed - order summary is generated dynamically in AI response
            break;
        case "CONFIRM_ORDER":
            await confirmOrder(session.callSid);
            break;
        case "CANCEL_ORDER":
            cancelOrder(session.callSid);
            break;
        case "REPEAT_MENU":
            // no action needed - menu is included in system prompt
            break;
        case "UNKNOWN":
            // no action needed - AI will generate a response asking user to repeat
            break;
    }
}

function findItem(Name) {
  /// TODO: use nlp to map name to menu item e.g margherita pizza -> margherita 
  const menu = MENU_DATA;
  const item = menu.find(i => i.Name.toLowerCase() === Name.toLowerCase());
  console.log("Found item:", JSON.stringify(item));
  return item;
}

function addItemToSession(callSid, itemName, quantity = 1) {
  const session = sessions.get(callSid);
  if (!session) {
    return {
      success: false,
      message: "Session not found"
    };
  }

  const item = findItem(itemName);

  if (!item) {
    return {
      success: false,
      message: `Sorry, I couldn't find "${itemName}" on our menu.`
    };
  }

  // Update quantity if item already in order
  const existing = session.items.find(l => l.item.Id === item.Id);
  if (existing) {
    existing.quantity += quantity;
  } else {
    session.items.push({ item, quantity });
  }

  return { success: true, item, quantity };
}

function removeItemFromSession(callSid, itemName) {
  const session = sessions.get(callSid);
  if (!session) return { success: false };

  const item = findItem(itemName);
  if (!item) return { success: false, message: `Couldn't find "${itemName}" to remove.` };

  const idx = session.items.findIndex(l => l.item.Id === item.Id);
  if (idx === -1) return { success: false, message: `${item.Name} isn't in your order.` };

  session.items.splice(idx, 1);
  return { success: true, item };
}

function getOrderTotal(callSid) {
  const session = sessions.get(callSid);
  if (!session) return 0;
  return session.items.reduce((sum, l) => sum + ((l.item.Price * l.quantity) * 1.125), 0);
}

function getOrderSummary(callSid) {
  const session = sessions.get(callSid);
  if (!session || session.items.length === 0) return "Your order is currently empty.";

  const lines = session.items.map(
    l => `${l.quantity}x ${l.item.Name} (£${(l.item.Price * l.quantity).toFixed(2)})`
  );
  lines.push(`Tax (12.5%): £${(session.items.reduce((sum, l) => sum + (l.item.Price * l.quantity), 0) * 0.125).toFixed(2)}`);
  const total = getOrderTotal(callSid);
  return `You have: ${lines.join(", ")}. Total: £${total.toFixed(2)}.`;
}


async function confirmOrder(callSid) {
  const session = sessions.get(callSid);
  if (!session || session.items.length === 0) {
    return { success: false, message: "There are no items in your order to confirm." };
  }
  session.status = "confirmed";
  session.confirmedAt = new Date();

  var SMSmessage = getOrderSummary(callSid);
  console.log("Order confirmed. Sending SMS with summary: ", SMSmessage);

  try{
    await client.messages.create({
        body: `Your order has been confirmed. ${SMSmessage}`,
        from: process.env.PHONE_NUMBER,
        to: session.callerNumber
    });

  } catch (error) {
    console.error("Error sending SMS:", error);
  }

  return { success: true, order: session };
}


function cancelOrder(callSid) {
  const session = sessions.get(callSid);
  if (session) {
    session.items = [];
    session.status = "cancelled";
  }
}

// BUILD MENU JSON FROM EXCEL
function createMenuJSON() {
    const workbook = xlsx.readFile(path.join(__dirname, "data", "menu_timings.xlsx"));

    const menu = workbook.Sheets[workbook.SheetNames[0]];
    const menuJSON = xlsx.utils.sheet_to_json(menu);

    //remove unnecessary fields from menuJSON e.g prep and make time
    var newMenuJSON = menuJSON.map(item => {
          return {
            Id: item.PLU,
            Name: item.Name,
            Description: item.Description,
            Price: parseFloat(item.Price.replace("&pound;", "")),
        };
    });

    return newMenuJSON;
}

//AI HELPER FUNCTIONS
const SYSTEM_PROMPT = `You are a friendly and efficient phone ordering assistant for a restaurant or takeaway.
Your job is to help callers place food orders over the phone.

MENU:
`+JSON.stringify(MENU_DATA)+`

RULES:
- Be concise — responses are read aloud over the phone, so keep them SHORT (1-3 sentences max).
- Always be warm, friendly, and professional.
- Only take orders from the menu above. Politely decline requests for items not listed.
- Quantities default to 1 unless the caller specifies otherwise.
- After each item is added, confirm it back to the caller briefly.

CRITICAL INSTRUCTION:
You must ALWAYS respond with a single JSON object that strictly matches this format. Do NOT wrap it in an array:
{
  "action": "ADD_ITEM" | "REMOVE_ITEM" | "SHOW_ORDER" | "CONFIRM_ORDER" | "CANCEL_ORDER" | "REPEAT_MENU" | "UNKNOWN",
  "items": [
    { "Name": "Exact Menu Item Name", "quantity": 1 }
  ],
  "speech": "The exact words you will say to the customer"
}`;

const ActionSchema = z.object({
    action: z.enum(["ADD_ITEM", "REMOVE_ITEM", "SHOW_ORDER", "CONFIRM_ORDER", "CANCEL_ORDER", "REPEAT_MENU", "UNKNOWN"]),
    items: z.array(z.object({
        Name: z.string(),
        quantity: z.number().optional(),
    })).optional(),
    speech: z.string()
});

async function queryAI( conversationHistory = []) {
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        systemInstruction: SYSTEM_PROMPT,
        contents: conversationHistory,
        config: {
            responseMimeType: "application/json",
            responseSchema: z.toJSONSchema(ActionSchema),
        },

    });

    //console.log(JSON.stringify(z.toJSONSchema(ActionSchema), null, 2));


    var res = response.text;
    console.log("RAW AI RESPONSE:", res);       

    var resJSON = JSON.parse(res);
    console.log("PARSED JSON:", resJSON);     

    const parseResult = ActionSchema.safeParse(resJSON);
    console.log("PARSE ERRORS:", parseResult.error); 

    if (!parseResult.success) {
        console.error("Failed to parse AI response:", parseResult.error);
        return ["UNKNOWN", [], "Sorry, I didn't understand that. Could you please repeat?"];
    }
    else{
        return [parseResult.data.action, parseResult.data.items, parseResult.data.speech];
    }

}
