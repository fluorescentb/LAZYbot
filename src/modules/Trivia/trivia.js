const Parse = require('../../util/parse.js');
const Embed = require('../../util/embed.js');
const DataManager = require('../../util/datamanager.js');
const Permissions = require('../../util/permissions.js');
const config = require('../../config.json');

const regexes = {
	bold: /\*/g,
	trivia: /\*\*([\S \t^@#:`]{2,32}#\d{4})\*\* has( \d{1,3}) points?/
};

class Trivia extends Parse {

	constructor(message) {
		super(message);
	}

	get trivia () {
		if (!this.server.trivia) this.trivia = {};
		return this.server.trivia;
	}

	set trivia (obj) {
		let server = this.getServer();
		server.trivia = obj;
		this.server = server;
	}

	get players () {
		if (!this.trivia.players) this.players = {};
		return this.trivia.players;
	}

	set players (obj) {
		let trivia = this.trivia;
		trivia.players = obj;
		this.trivia = trivia;
	}
	
	/**
	 * Lists the users who are currently playing trivia
	 * @private
	 */
	gen() {
		this.Output.sender(new Embed()
			.setTitle('Now playing rated trivia')
			.setDescription(Object.entries(this.players)
				.filter(([, playing]) => playing)
				.map(([player]) => player === this.user.tag ? '**' + player + '**' : player)
				.reverse()
				.join('\n') || ''
			)
		);
		return this;
	}

	/**
	 * Starts logging users participating in a new Trivia game on nadeko bot
	 * @param {string[]} args 
	 * @private
	 */
	init(args = this.args) {
		if (this.server.states.trivia) return;
		for (let a of args) {
			if (/^(:?--pokemon|-p)$/.test(a)) return;
		}
		this.server.states.trivia = true;
		DataManager.setServer(this.server);
		this.gen();
		return this;
	}

	/**
	 * Ends logging of trivia players
	 * @private
	 */
	async end() {
		this.players = {};
		let server = this.server;
		server.states.trivia = false;
		this.server = server;
	}
	
	/**
	 * Lists the users who are currently playing trivia
	 * @public
	 */
	async show() {
		try {
			if (!this.server.states.trivia) throw 'Not currently playing rated trivia!';
			this.gen();
		} catch (e) {
			if (e) this.Output.onError(e);
		}
	}

	/**
	 * Forces a users who was not previous rated to be rated
	 * @param {string} argument
	 * @public
	 */
	async rate(argument = this.argument) {
		try {
			if (!this.server.states.trivia) throw 'Not currently playing rated trivia!';
			if (argument) {
				if (!(await Permissions.role('admin', this))) throw Permissions.output('role');
				this.user = this.Search.users.get(argument);
				if (!this.user) throw 'Couldn\'t find user ' + argument + '!';
			}
			this.onNewMessage(this.user, true);
		} catch (e) {
			if (e) this.Output.onError(e);
		}
	}

	/**
	 * Logs a new user to the database
	 * @param {User} user 
	 */
	async onNewMessage(user = this.author, force = false) {
		try {
			if (user.id === '392031018313580546') throw '';
			if (typeof this.players[user.tag] !== 'undefined' && !force) throw '';
			let players = this.players;
			players[user.tag] = true;
			this.players = players;
			let playing = await this.Output.confirm({
				description: `**${user.tag}** joined rated trivia.\nType \`n\` or press ❎ in 10s to cancel.`,
				errors: ['time'],
				cancel: true
			}, true);
			if (playing) this.gen();
			else {
				players[user.tag] = false;
				this.players = players;
			}
		} catch (e) {
			if (e) this.Output.onError(e);
		}
	}

	/**
	 * Converts a 2x2 Array of tags (UserResolvables) and scores to 2x3 of dbuser objects, an estimate of strength, and their score
	 * @param {string} tag 
	 * @param {number} score 
	 * @returns {string[]}
	 * @param {DBuser} dbuser
	 * @param {Number} estimate
	 * @param {Number} score
	 */
	nameToTriviaData(tag, score) {
		let user = this.Search.users.byTag(tag.replace(regexes.bold, '')); //byTag filters out the **
		if (!user) return null;
		let dbuser = this.Search.dbusers.getUser(user);
		if (!dbuser.trivia) dbuser.trivia = {
			rating: 1500,
			games: 0
		};
		let estimate = Math.pow(10, (dbuser.trivia.rating - config.trivia.initial) / config.trivia.spread); //ex: (2000 - 1500) / 1589 or (1400 - 1500 / 1589
		return [dbuser, estimate, Number(score)];
	}

	/**
	 * Parses the result object outputted at the end of a trivia game and uses it to update trivia score values
	 * @param {Embed} embed 
	 * @private
	 */
	async ratingUpdate(embed) {
		try {
			const lines = embed.description.split('\n');
			let players = this.players;
			let scored = lines
				.map(line => regexes.trivia.test(line) ? line.match(regexes.trivia).slice(1) : [''])
				.map(arr => this.nameToTriviaData(...arr))
				.filter((d) => {
					if (!d) return false;											//Users who left the server halfway through the trivia match
					if (!this.server.trivia.players[d[0].username]) return false;	//Anyone not playing is excluded
					players[d[0].username] = false;									//Only people not scored but playing are left
					return true;
				});
			let unscored = Object.entries(players)								//Players who got 0
				.filter(([, unranked]) => unranked)
				.map(([name]) => this.nameToTriviaData(name, 0));
			let data = scored.concat(unscored);
			let description = '';
			try {
				if (data.length === 0) throw '';
				let [totalEstimate, totalScore] = data.reduce(([e, s], [, estimate, score]) => [e + estimate, s + score], [0, 0]);
				if (data[0][2] < this.server.trivia.min) throw `Only ${this.server.trivia.min}+ point games are rated.\nActive players: ${data.map(([dbuser]) => dbuser.username).join(', ')}`;
				if (data.length < 2) throw 'Only games with 2+ players are rated.\nActive players: ' + data.map(([dbuser]) => dbuser.username).join(', ');
				for (let [dbuser, estimate, score] of data) {
					let shareEstimate = (estimate / totalEstimate) * totalScore;
					let RD = Math.max(50 - (dbuser.trivia.games || 0) * 3, 10);
					let difference = RD * (score - shareEstimate);
					dbuser.trivia.rating = Math.round(difference + dbuser.trivia.rating);
					dbuser.trivia.games++;
					description += '**' + dbuser.username + '** ' + dbuser.trivia.rating + (dbuser.trivia.games < this.server.trivia.provisional ? '?' : '') + ' (' + difference.toSign() + ')\n';
					dbuser.setData();
				}
			} catch (e) {
				if (e) this.Output.onError(e);
			}
			await this.Output.sender(new Embed()
				.setAuthor('Trivia Game Ended.')
				.setTitle(description ? 'Trivia Rating Update' : '')
				.setDescription(description)
			);
			this.end();
		} catch (e) {
			if (e) this.Output.onError(e);
		}
	}

	/**
	 * 
	 * @param {string} argument 
	 */
	async rating(argument = this.argument) {
		try {
			let user = this.user;
			if (argument) user = this.Search.users.get(argument);
			if (!user) throw 'Couldn\'t find user **' + argument + '**!';
			let dbuser = this.Search.dbusers.getUser(user);
			this.Output.sender(new Embed()
				.setTitle('Trivia Rating')
				.setDescription(`**${dbuser.username}** ${dbuser.trivia ? dbuser.trivia.rating || 1500 : 1500}${(!dbuser.trivia || dbuser.trivia.games < this.server.trivia.provisional) ? '?' : ''}`)
			);
		} catch (e) {
			if (e) this.Output.onError(e);
		}
	}

}

module.exports = Trivia;