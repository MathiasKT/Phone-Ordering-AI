# AI Phone Ordering System

Stack
-----
- twilio (phone number and other)
- twilio Amazon polly (voice response)
- gemini ( for ai conversation flow)
- node + express js (server)
- ngrok - dev 
- ????? - payment link


process
------
1. customer dials twilio number  ✅
2. server generates a session, greets caller and listens to voice ✅
3. speech result achieved and sent to ai ✅
4. ai generates JSON ( action items and text of what was said) ✅
5. action applied to order (add, remove, confirm, cancel, etc) - NEED TO ADD ITEM FILTER, TO CHECK ITS ON THE MENU
6. response is said to user ✅
7. listens again ( goes back to #3 until confirm action)
8. send closing message and hangup✅
9. send sms with order details and payment link to customer
10. on payment link confrimation for user use KMS API to construct takeout order


.env file needed
-------------------
#SERVER
- PORT=
- BASE_URL=

#TWILIO
- PHONE_NUMBER=
- TWILIO_ACCOUNT_SID=
- TWILIO_AUTH_TOKEN=

#AI keys
- GEMINI_API_KEY=

todo
----
- get twilio number need business regualtory info - DONE personal ✅
    - need busienss registitration number
    - business website
    - potentially more ?
- get gemini api key (step 4-6) -✅

- map what order wants to menu and give error if not:

- get allergy info (step 4-7)
- get kms api (step 10)
- get payment link (stripe)?



