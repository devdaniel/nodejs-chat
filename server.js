// https://tools.ietf.org/html/rfc1459

// npm install net redis fs ini json
var net = require('net');
var fs = require('fs');
var ini = require('ini');
//var redis = require('redis');
//var json = require('json');

var config = ini.parse(fs.readFileSync('./server.ini', 'utf-8'));
// TODO validate config, set defaults

/*
// Redis client
console.log('Connecting to REDIS on ' + config.redis.host + ':' + config.redis.port);
var redis_ready = false;
var redis_prefix = config.redis.prefix;
var redis_client = redis.createClient(6379, '127.0.0.1', {return_buffers: true});
redis_client.on("error", function(err) {
	console.log("Redis Error: "+err);
});
redis_client.on('ready', function() {
	console.log('Connected to REDIS');
	redis_ready = true;
});
*/

// Global scope stuff
var clients = [];			// Connected client index
var nickname_index = {};	// Nickname index (map to client index)
var channels = {};			// Channel index

// Insert into the first available 'null' slot. If none found, append
// Return index of inserted element
Array.prototype.insert_first_available = function(el) {
	for(var i = 0, len = this.length; i < len; i++) {
		if(this[i] == null) {
			this[i] = el;
			return i;
		}
	}
	this.push(el);
	return this.length-1;
}

// Compare two buffers
// return true if exact match
Buffer.prototype.compare = function(other) {
	if(this.length != other.length) {
		return false;
	}
	for(var i = 0, len = this.length; i < len; i++) {
		if(this.readUInt8(i) != other.readUInt8(i)) {
			return false;
		}
	}
	return true;
}

// Compare something with end of buffer
// return true if self ends with other buffer
Buffer.prototype.endswith = function(other) {
	if(other.length > this.length) {
		return false;
	}
	for(var i = 0, len = other.length; i < len; i++) {
		var offset = this.length-len;

		if(this.readUInt8(offset+i) != other.readUInt8(i)) {
			return false;
		}
	}
	return true;
}

// Client object
function Client(socket) {
	var socket = socket;	// our own socket
	var client_id = false;	// our index (in global clients index)
	var nick = false;		// our nickname
	var channel = false;	// our current channel

	var input_buffer = new Buffer(''); // Workaround for clients sending partial data i.e. Windows telnet sends every character typed

	// Setters/Getters
	var setId = function(new_id) {
		client_id = new_id;
	};

	var getId = function() {
		return client_id;
	};

	var getNick = function() {
		return nick;
	};

	// Handle input from client, includes working with input_buffer
	var handleInput = function(input) {
		// Backspace = 8
		// Return = 13, 10 (\r\n)
		var backspace = new Buffer([8]);
		var newline = new Buffer([13, 10]);

		if(input.compare(backspace)) {
			if(input_buffer.length > 0) {
				input_buffer = input_buffer.slice(0, input_buffer.length-2);
			}
		} else {
			input_buffer = Buffer.concat([input_buffer, input]);
		}
		if(input.endswith(newline)) {
			var retval = handleCommand(input_buffer.toString());
			input_buffer = new Buffer('');
			return retval;
		}
	};

	// Handle commands send by client
	var handleCommand = function(command) {
		command = command.replace('\r\n','');
		var segments = command.split(' ');
		// Force /nick or /quit as only valid commands until nickname is set
		if(!nick && segments[0] != '/nick' && segments[0] != '/quit') {
			initRegistration();
			return;
		}
		if(command.substring(0,1) == '/') {
			// Handle the commands by calling appropriate function
			switch(segments[0]) {
				case '/nick':
					changeNickname(segments[1]);
					return;
				case '/join':
					partChannel(); // Whoa there, one at a time.
					joinChannel(segments[1]);
					return;
				case '/part':
					partChannel();
					return;
				case '/leave':
					partChannel();
					return;
				case '/list':
					listAllRooms();
					return;
				case '/rooms':
					listAllRooms();
					return;
				case '/quit':
					partChannel(); // It's rude to leave without saying goodbye
					disconnect();
					return;
				case '/?':
					// Some help
					send('Currently supported commands:');
					send('/nick <nickname> - Change your nickname to <nickname>');
					send('/join <roomname> - Join <roomname> chatroom (leaves current room)');
					send('/part - Leave your current chatroom');
					send('/leave - Leave your current chatroom');
					send('/list - List all rooms and number of members');
					send('/rooms - List all rooms and number of members');
					send('/quit - Disconnect from server');
					return;
				default:
					// Unknown or unsupported command
					send('Unknown command.');
					if(!channel) {
						// A little help here
						send('Join a chat with /join <name>');
					}
					return;
			}
		}
		if(!channel) {
			send('You are not in a chat.');
			return;
		}

		// Handle as chat message
		console.log(nick + ' sending to room ' + channel + ': ' + command);
		channels[channel].send_message(client_id, command);
	};

	// Force user to set nickname
	var initRegistration = function() {
		nick = false;
		send('Please register a nickname first with /nick <nickname>');
	};

	// Attempt to change nickname by checking nickname index first.
	var changeNickname = function(new_nickname) {
		if(typeof(nickname_index[new_nickname]) != 'undefined') {
			send('Nickname taken, try another.');
			return;
		}
		if(channel) {
			channelNickchangeNotify(nick, new_nickname);
		}
		delete nickname_index[nick];
		nick = new_nickname;
		nickname_index[new_nickname] = client_id;
		send('Welcome, '+ nick);
	}

	// Join a channel/room
	var joinChannel = function(channel_name) {
		if(channel_name == channel) {
			send('You are already in this channel.');
			return;
		}
		// Only alphanumeric
		var allowed_channel_names = /^[A-Za-z]+$/;
		if(allowed_channel_names.test(channel_name)) {
			if(typeof(channels[channel_name]) == 'undefined') {
				channels[channel_name] = new Channel(channel_name, client_id);
			} else {
				channels[channel_name].join(client_id);
			}

			send('entering room: '+channel_name);
			channel = channel_name;
			var users = channels[channel_name].getClients();
			for(var i = 0, len = users.length; i < len; i++) {
				send('* '+clients[users[i]].getNick());
			}
			send('end of list.');
		}
		else {
			send('Unable to join channel (invalid characters)')
			console.log('attempted bad channel: '+channel_name);
		}
	};

	// Leave current channel/room
	var partChannel = function() {
		if(channel) {
			channels[channel].part(client_id);
			channel = null;
		}
	};

	// Notify the channel of a nickname change.
	var channelNickchangeNotify = function(before, after) {
		channels[channel].nickname_change(before, after);
	};

	// List all rooms
	var listAllRooms = function() {
		send('Active rooms are:');
		for(var name in channels) {
			send('* ' + name + ' (' + channels[name].clientCount() + ')');
		}
		send('end of list.')
	};

	// Say goodbye and disconnect client
	var disconnect = function() {
		socket.end('BYE\r\n');
		// Note: Cleanup is handled in Server via event listener
	};

	// Send a message to client, with CRLF
	var send = function(data) {
		if(socket.writable) {
			socket.write(data + '\r\n');
		}
	};

	// Public methods
	return {
		setId : setId,
		getId : getId,
		getNick : getNick,
		handleCommand : handleCommand,
		handleInput : handleInput,
		initRegistration : initRegistration,
		send : send
	};
}

// Channel object
function Channel(name, creator) {
	var channel_name;				// Channel's name
	var channel_clients = [];		// Index of client ids in channel
	var channel_operators = [];		// TODO: Channel operators
	var channel_moderators = [];	// TODO: Channel moderators

	console.log('New channel ' + channel_name + ' created by ' + clients[creator].getNick());

	channel_clients = [creator];
	// TODO Handle creator auto-op

	// Get number of clients in channel
	var clientCount = function() {
		return channel_clients.length;
	};

	// Get client index
	var getClients = function() {
		return channel_clients;
	};

	// Run callback on each client id in channel
	var forEachMember = function(callback) {
		for(var i = 0, len = channel_clients.length; i < len; i++) {
			if(typeof(clients[channel_clients[i]]) == 'object') {
				callback(clients[channel_clients[i]]);
			}
		}
	};

	// Handle client joining channel
	var join = function(client_id) {
		var joining_nickname = clients[client_id].getNick();
		forEachMember(function(client) {
			client.send('* new user joined chat: ' + joining_nickname);
		})
		channel_clients.push(client_id);
	};

	// Handle client leaving channel
	var part = function(client_id) {
		var parting_nickname = clients[client_id].getNick();
		forEachMember(function(client) {
			client.send('* user has left chat: ' + parting_nickname);
		});
		var client_index = channel_clients.indexOf(client_id);
		channel_clients.splice(client_index, 1);
		// TODO Keep or destroy channel when empty?
	};

	// Notify channel members of a nickname change
	var nickname_change = function(before, after) {
		forEachMember(function(client) {
			client.send(before + ' has changed their nickname to ' + after);
		})
	};

	// Send a message to all clients in channel
	var send_message = function(client_id, message) {
		var sending_nickname = clients[client_id].getNick();
		forEachMember(function(client) {
			client.send(sending_nickname + ': ' + message);
		});
	};

	// Public methods
	return {
		clientCount : clientCount,
		getClients : getClients,
		join : join,
		part : part,
		nickname_change : nickname_change,
		send_message : send_message
	};
}

// Server object
function Server() {
	// Handle new client connection request
	var acceptClient = function(socket) {
		// Create new Client object, and set up index entry
		var new_client = new Client(socket);
		var client_id = clients.insert_first_available(new_client);
		new_client.setId(client_id);

		// Clean up client index on connection closure
		socket.on('close', function(data) {
			console.log(socket._peername.address + ':' + socket._peername.port + ' disconnected.');
			delete clients[client_id];
		});

		// Pass client sending input onto Client object
		socket.on('data', function(data) {
			clients[client_id].handleInput(data);
		});

		// Send client the MOTD from config file
		new_client.send(config.server.motd);

		// Force client to register a nickname first
		new_client.initRegistration();
	};

	// Public methods
	return {
		acceptClient : acceptClient
	};
}

// Net stuff
var chatserver = new Server();

var server = net.createServer(function(connection) {
	console.log('client connected: '+ connection.remoteAddress + ':' + connection.remotePort);

	chatserver.acceptClient(connection);
});

server.listen(config.server.port, function() {
	console.log('started server');
});
