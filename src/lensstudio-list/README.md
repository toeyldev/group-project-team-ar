# Lens Studio Grocery Checklist

`GroceryListController.js` displays items returned by a checklist API. It polls
every five seconds and shows `[ ]` for unchecked items, `[x]` for checked items,
and completed/total progress. Mock mode is off by default.

## Add the controller to a Spectacles Lens

1. Open `lensstudio-snapMLstarter.esproj` from this folder in Lens Studio.
2. Create a **Screen Text** object named `GroceryListText`.
3. Add a **Script Component** and select `Assets/GroceryListController.js` from
   the Asset Browser.
4. Optionally assign the object's Text component to **Grocery Text**; otherwise
   the script finds the Text component on the same object.
5. Start the Node API from the repository's `server` folder with `npm run dev`.
   For Lens Studio Preview on this computer, set **API URL** to
   `http://127.0.0.1:3000/api/items`. For Spectacles, use an active HTTPS tunnel
   to port 3000 and set the URL to `https://<your-tunnel-host>/api/items`.
   Spectacles cannot use `127.0.0.1` to reach your computer.
6. Leave **Mock Mode** off for live checklist data.

For local HTTP Preview, enable **Project Settings → General → API Settings →
Allow Experimental API** and set the Preview device type to **Spectacles**.
Experimental API mode is for testing and prevents public publishing.

The controller accepts the Node API's item array (`name` and `status` fields)
or the FastAPI response with an `items` array (`name` and `checked` fields).
The app and Lens call the API; neither client connects directly to a database.
