# mplus

Install Node.js, run `npm install` to install dependencies 

Run it via `./app.js $PACKAGE_ID$`

read the class hierarchy output @ `/__handlers__/$PACKAGE_ID$/metadata.json`, pick intersting method & intercept with `intercept({ className: "NetworkDriver", methodName: "SomeMethod" });` to log the method & arguments

interceptors should be inside `/__handlers__/$PACKAGE_ID$/inject.js` 

question ? [click here](https://github.com/iddoeldor/mplus/issues/new)

I'll update this README with GIFs and couple more examples (+ update the db interface to use mongodb)


GL & HF





References

* [frida setup & basics](https://youtu.be/sdpEJguRd6o?t=1070)
