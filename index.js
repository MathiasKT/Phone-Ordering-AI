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

//MENU
const MENU_DATA = createMenuJSON();
const ALLERGEN_DATA = null; // TODO
const aliasMap = {
    // Pizzas
    "margherita pizza": "Margherita",
    "cheese pizza": "Margherita",
    "plain pizza": "Margherita",
    "pepperoni pizza": "Diavola",
    "spicy salami pizza": "Diavola",
    "spicy pizza": "Diavola",
    "anchovy pizza": "Napoli",
    "ham and mushroom": "Prosciutto e Funghi",
    "spinach and egg": "Fiorentina Virgin",
    "florentine pizza": "Fiorentina Virgin",
    "parma ham pizza": "Sebastian",
    "nduja pizza": "Calabrese",
    "vegetarian pizza": "Vegetariana",
    "veg pizza": "Vegetariana",

    // Starters / Breads
    "cheesy garlic bread": "Garlic Bread with Cheese",
    "garlic bread cheese": "Garlic Bread with Cheese",
    "tomato garlic bread": "Garlic Bread Marinara",
    "bowl of olives": "Mixed Olives",
    "tomato bruschetta": "Bruschetta Classica",
    
    // Platters / Mains / Salads
    "meat board": "Tagliere di Terra",
    "meat platter": "Tagliere di Terra",
    "charcuterie": "Tagliere di Terra",
    "vegetarian platter": "Antipasto Vegetariano",
    "veg platter": "Antipasto Vegetariano",
    "soup of the day": "Zuppa del Giorno",
    "soup": "Zuppa del Giorno",
    "beef carpaccio": "Carpaccio di Manzo",
    "caprese salad": "Insalata Caprese",
    "tomato and mozzarella salad": "Insalata Caprese",
    "king prawns": "Gamberoni alla Sebastian",
    "prawns": "Gamberoni alla Sebastian",
    "bowl of mussels": "Mussels",
    "veal": "Vitello Tonnato",
    "goat cheese salad": "Caprino Grigliato",
    "grilled goat cheese": "Caprino Grigliato",
    "eggplant parmigiana": "Melanzana Small",
    "aubergine parmigiana": "Melanzana Small",
    "baked aubergine": "Melanzana Small"
  };



//SEARCH
const Fuse = require("fuse.js");
const FUSE_OPTIONS = {
  includeScore: true,
  threshold: 0.45,
  keys: [{ name: "Name", weight: 0.8 }, { name: "Description", weight: 0.2 }]
}
const fuse = new Fuse(MENU_DATA, FUSE_OPTIONS);

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
    //console.log("gathering info from " + callerNumber + " (SID: " + callSid + ")");

    // get text from speech recognition and add to conversation history
    const userSpeech = req.body.SpeechResult || "";
    const session = getOrCreateSession(callSid, callerNumber);

    console.log("############");
    console.log("User said: ", userSpeech);
    console.log("############");

    if (userSpeech) {
      session.conversationHistory.push({ role: "user", parts: [{ text: userSpeech }] });
    }

    if (session.pendingItem && userSpeech) {
    const lastEntry = session.conversationHistory[session.conversationHistory.length - 1];
    lastEntry.parts[0].text += ` [SYSTEM: The customer was previously asked to confirm "${session.pendingItem.item.Name}". If their response is positive (yes, sure, ok, that's fine etc.), return action CONFIRM_ITEM. If negative, clear the suggestion and ask what they want instead.]`;
    }

    // query ai for response
    const [action, items, AIresponse] = await queryAI(session.conversationHistory);
    
    const finalSpeech = (await decideAction(action, items, session)) || AIresponse;
    session.conversationHistory.push({ role: "model", parts: [{ text: finalSpeech }] });

    console.log("############");
    console.log("Action:", action, "| Items:", JSON.stringify(items));
    console.log("AI responded: ", AIresponse);
    if (finalSpeech !== AIresponse) console.log("System Overrode Speech to: ", finalSpeech);
    console.log("############");

    //base condition for ending call
    if (action === "CONFIRM_ORDER") {
      await confirmOrder(session.callSid);
      const twiml = new VoiceResponse();
      twiml.say({ voice: speaker, language: language }, AIresponse);
      twiml.hangup();
      res.type("text/xml");
      return res.send(twiml.toString());
    }

  if (action === "CANCEL_ORDER") {
    cancelOrder(session.callSid);
    const twiml = new VoiceResponse();
    twiml.say({ voice: speaker, language: language }, AIresponse);
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

    //build and send twiml response based on AI response
    const twiml = new VoiceResponse();
    const gather = twiml.gather({
        input: "speech",
        action: "/voice/process",
        speechTimeout: "auto",
    });

    gather.say( { voice: speaker, language: language },finalSpeech);

    res.type("text/xml");
    res.send(twiml.toString());

    console.log("############");
    console.log("Conversation History: ", session.conversationHistory);
    console.log("############");

    await decideAction(action, items, session);
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
      items: [],          // { item, quantity, modifiers }
      pendingItem: null, // item waiting for confirmation { item, quantity, modifiers }
      status: "ordering", // ordering | confirmed | cancelled
      createdAt: new Date(),
      conversationHistory: [], //  message history
    });
  }
  return sessions.get(callSid);
}

//ACTIONS
async function decideAction(action, items, session) {
  //"ADD_ITEM", "REMOVE_ITEM", "CONFIRM_ITEM" "SHOW_ORDER", "CONFIRM_ORDER", "CANCEL_ORDER", "SAY_MENU", "UNKNOWN"
  var overrideSpeech;


    switch(action){
        case "ADD_ITEM":
            items.forEach(item => {
                var res = addItemToSession(session.callSid, item.Name, item.quantity);
                if (!res.success && res.pending) {
                    overrideSpeech = res.message;
                    } else if (!res.success) {
                        overrideSpeech = res.message;
                    }
                    console.log(`[ADD_ITEM] ${item.Name} →`, res);
                });
                break;
              
        case "CONFIRM_ITEM":
            if (session.pendingItem) {
                const { item, quantity } = session.pendingItem;
                const existing = session.items.find(l => l.item.Id === item.Id);
                if (existing) {
                    existing.quantity += quantity;
                } else {
                    session.items.push({ item, quantity });
                }
                session.pendingItem = null; // clear it
            }
            break;
      
        case "REMOVE_ITEM":
            items.forEach(item => {
               removeItemFromSession(session.callSid, item.Name);
            });
            break;
        case "TELL_ORDER":
            // no action needed - order summary is generated dynamically in AI response
            break;
          
        case "GIVE_PRODUCT_DETAILS":
            break;

        case "GIVE_RECOMMENDATION":
          if (!items || items.length === 0) {
                overrideSpeech = "I'd recommend trying our Margherita or Garlic Bread — both very popular. What sounds good?";
                break;
          }
            // Validate each recommended item actually exists
            const validItems = items
                .map(i => findItem(i.Name))
                .filter(r => r.status === "found")
                .map(r => r.item.Name);

            if (validItems.length === 0) {
                // AI hallucinated everything — use a safe fallback
                overrideSpeech = "I'd recommend our Margherita pizza or Garlic Bread — both very popular. What sounds good?";
            } else {
                // Build speech from only validated items
                overrideSpeech = `I'd recommend ${validItems.join(" or ")} — both great choices. What sounds good to you?`;
            }
            break;
        
        case "REPEAT_MENU":
            // no action needed - menu is included in system prompt
            break;
        case "UNKNOWN":
            // no action needed - AI will generate a response asking user to repeat
            break;
    }
    return overrideSpeech;
}

//working
function findItem(Name) {
  /// TODO: use nlp to map name to menu item e.g margherita pizza -> margherita 



  for (const [alias, realName] of Object.entries(aliasMap)) {
    if (Name.includes(alias)) {
      // If it's an alias, do a strict search for the real name
      const match = fuse.search(realName)[0];
      return {
        status: 'alias',
        item: match.item,
        message: `We don't have ${alias}, but we do have the ${match.item.Name}.`
      };
    }
  }

  const result = fuse.search(Name);

  if (result.length > 0) {
    console.log("Fuzzy search results:", result);
    var best_match  = result[0];

    if (best_match.score < 0.3) { // adjust threshold as needed
      console.log(`Fuzzy match found for "${Name}":`, best_match);
      return {
        status: "found",
        item: best_match.item,
      };
    }
    else {
      return { status: "alias", item: best_match.item, message:`weak match ${best_match.item.Name}` };
    }
  }
  else{
    console.log("No fuzzy match found for:", Name);
    return {
      status: "not_found",
      item: null
    };
  }
}

// working
function addItemToSession(callSid, itemName, quantity = 1) {
  const session = sessions.get(callSid);
  if (!session) {
    return {
      success: false,
      message: "Session not found"
    };
  }

  const result = findItem(itemName);

  switch (result.status) {
    case "not_found":
      return {
        success: false,
        message: `Sorry, I couldn't find "${itemName}" on our menu.`
      };
    case "alias":
      // confirm with user if they meant the recommended item
      session.pendingItem = { item: result.item, quantity };
      return {
        success: false,
        pending: true,
        item: result.item,
        message: `We don't have that, but we have ${result.item.Name}. Would you like that instead?`
      };
    default:
    case "found":
        const existing = session.items.find(l => l.item.Id === result.item.Id);
        if (existing) {
          // Update quantity if item already in order
          existing.quantity += quantity;
        } else {
          session.items.push({ item: result.item, quantity });
        }

        return { success: true, item: result.item, quantity };
  }

 
}


//working
function removeItemFromSession(callSid, itemName) {
  const session = sessions.get(callSid);
  
  if (!session || !session.items || session.items.length === 0) {
    return { success: false, message: "Your order is currently empty." };
  }

  const cartItems = session.items.map(cartRow => cartRow.item);

  const tempFuseOptions = { includeScore: true, threshold: 0.5, keys: ["Name"] };
  const cartSearch = new Fuse(cartItems, tempFuseOptions);
  
  const result = cartSearch.search(itemName);

  if (result.length === 0 || result[0].score > 0.4) {
    return { 
      success: false, 
      message: `I couldn't find ${itemName} in your current order.` 
    };
  }

  const matchedItem = result[0].item;
  const idx = session.items.findIndex(l => l.item.Id === matchedItem.Id);

  if (session.items[idx].quantity > 1) {
    session.items[idx].quantity -= 1;
  } else {
    session.items.splice(idx, 1);
  }

  return { success: true, item: matchedItem };
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
    session.pendingItem = null;
  }
}

// BUILD MENU JSON FROM EXCEL
function createMenuJSON() {
    const workbook = xlsx.readFile(path.join(__dirname, "data", "menu_timings_shortened.xlsx"));

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
- GIVE_RECOMMENDATION: You MUST populate the "items" array with 2-3 real items from the MENU JSON.
  Your "speech" should reference ONLY those exact item names. Do not mention any item not in the items array.

MENU:
`+JSON.stringify(MENU_DATA)+`

RULES:
- Be concise — responses are read aloud over the phone, so keep them SHORT (1-3 sentences max).
- Always be warm, friendly, and professional.
- Only take orders from the menu above. Politely decline requests for items not listed on MENU JSON.
- Quantities default to 1 unless the caller specifies otherwise.
- NEVER invent menu items. 
- GIVE_RECOMMENDATION: You MUST choose items ONLY from the MENU JSON above. 
  Copy the Name field EXACTLY as it appears. Put chosen items in the "items" array.
  If you cannot find suitable items in the menu, use action UNKNOWN instead.
  NEVER mention food that does not appear in the MENU JSON — not in speech, not in items.

CRITICAL: You do NOT decide if an item is on the menu. When a customer requests an item, 
  return ADD_ITEM with the name they said EXACTLY as spoken. The system will check if it exists 
  and handle suggestions. NEVER say you have added an item until the system confirms it.
  If the customer asks for something, ALWAYS use ADD_ITEM and let the system validate it.
  Your speech for ADD_ITEM should be "Let me check if we have that for you..." NOT 
  "I've added X to your order."

CRITICAL INSTRUCTION:
You must ALWAYS respond with a single JSON object that strictly matches this format. Do NOT wrap it in an array:
{
  "action": "ADD_ITEM" | "CONFIRM_ITEM" | "REMOVE_ITEM" |  "CONFIRM_ORDER" | "CANCEL_ORDER" | "TELL_ORDER" | "GIVE_CATEGORY_DETAILS" | "GIVE_PRODUCT_DETAILS" | "GIVE_RECOMMENDATION" | "REPEAT_MENU" | "UNKNOWN",
  "items": [
    { "Name": "Exact Menu Item Name", "quantity": 1 }
  ],
  "speech": "The exact words you will say to the customer"
}`;

const ActionSchema = z.object({
    action: z.enum(["ADD_ITEM", "CONFIRM_ITEM", "REMOVE_ITEM", "TELL_ORDER", "CONFIRM_ORDER", "CANCEL_ORDER", "GIVE_PRODUCT_DETAILS", "GIVE_RECOMMENDATION", "REPEAT_MENU", "UNKNOWN"]),
    items: z.array(z.object({
        Name: z.string(),
        quantity: z.number().optional(),
    })).optional(),
    speech: z.string()
});

async function queryAI( conversationHistory = []) {
    const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite-preview",
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
