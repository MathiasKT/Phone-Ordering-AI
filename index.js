
//Server
const express = require("express");
const xlsx = require("xlsx");
const path = require("path");
const app = express();
const port = process.env.PORT || 3000;


//twilio 
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const Voice = require("twilio/lib/rest/Voice");
const speaker = "Polly.Joanna";
const language = "en-GB";

//AI
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({apiKey: GEMINI_API_KEY});


const client = require('twilio')(accountSid, authToken,{
    region: "IE1",
    edge: "london",
    logLevel: "debug"
});


// ROUTES
app.get("/", (req, res) => {
  res.send("Hello World!");
});


app.post("/voice/incoming", (req, res) => {
    const  callSid = req.body.CallSid;
    const callerNumber = req.body.From || "anonymous";

    console.log("Received incoming call from " + callerNumber + " (SID: " + callSid + ")");
    
    getOrCreateSession(callSid, callerNumber);
    
    const twiml = new VoiceResponse();

    twiml.say("Thank you for calling");
    res.type("text/xml");
    res.send(twiml.toString());

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
    const { orderId, customerPhone, items, total } = req.body;

    try {
        await client.messages.create({
            body: `Your order ${orderId} has been confirmed. Total: ${total}. Items: ${items.join(", ")}`,
            from: process.env.PHONE_NUMBER,
            to: customerPhone
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
    console.log(`Example app listening at http://localhost:${port}`);
})



//HELPER FUNCTIONS
const { v4: uuidv4 } = require("uuid");
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
  const existing = session.items.find(l => l.item.id === item.id);
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

  const idx = session.items.findIndex(l => l.item.id === item.id);
  if (idx === -1) return { success: false, message: `${item.name} isn't in your order.` };

  session.items.splice(idx, 1);
  return { success: true, item };
}

function getOrderTotal(callSid) {
  const session = sessions.get(callSid);
  if (!session) return 0;
  return session.items.reduce((sum, l) => sum + ((l.item.price * l.quantity) * 1.125), 0);
}

function getOrderSummary(callSid) {
  const session = sessions.get(callSid);
  if (!session || session.items.length === 0) return "Your order is currently empty.";

  const lines = session.items.map(
    l => `${l.quantity}x ${l.item.name} (£${(l.item.price * l.quantity).toFixed(2)})`
  );
  lines.push(`Tax (12.5%): £${(session.items.reduce((sum, l) => sum + (l.item.price * l.quantity), 0) * 0.125).toFixed(2)}`);
  const total = getOrderTotal(callSid);
  return `You have: ${lines.join(", ")}. Total: £${total.toFixed(2)}.`;
}


function confirmOrder(callSid) {
  const session = sessions.get(callSid);
  if (!session || session.items.length === 0) {
    return { success: false, message: "There are no items in your order to confirm." };
  }
  session.status = "confirmed";
  session.confirmedAt = new Date();
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
            Name: item.Name,
            Description: item.Description,
            Price: item.Price
        };
    });

    return newMenuJSON;
}

//AI HELPER FUNCTIONS
SYSTEM_PROMPT = `You are a friendly and efficient phone ordering assistant for a restaurant or takeaway.
Your job is to help callers place food orders over the phone.

MENU:
${createMenuJSON()}

RULES:
- Be concise — responses are read aloud over the phone, so keep them SHORT (1-3 sentences max).
- Always be warm, friendly, and professional.
- Only take orders from the menu above. Politely decline requests for items not listed.
- Quantities default to 1 unless the caller specifies otherwise.
- After each item is added, confirm it back to the caller briefly.`;

const ActionSchema = z.object({
    action: z.enum(["ADD_ITEM", "REMOVE_ITEM", "SHOW_ORDER", "CONFIRM_ORDER", "CANCEL_ORDER", "REPEAT_MENU", "UNKNOWN"]),
    items: z.array(z.object({
        name: z.string(),
        quantity: z.number().optional(),
    })),
    speech: z.string(),
});

async function queryAI(text, conversationHistory = []) {
    const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseJsonSchema: zodToJsonSchema(ActionSchema),
        },
    });
}
