// This is a dummy server so we can periodically ping the repl.it host using uptimerobot
// To keep it from going to sleep
const server = require('express')();
server.all('/', (req, res) => {
	res.send('Your bot is alive!');
});
server.listen(3000, () => {
	console.log('Server is Ready!');
});

require('dotenv').config();

const char_to_emoji = require('./emoji_characters');
const emoji_to_char = Object.entries(char_to_emoji).reduce(
	(ret, [key, value]) => {
		ret[value] = key.toString();
		return ret;
	},
	{}
);
const {
	weighted_roll,
	compare_no_case,
	days_since_date,
	pretty_date,
} = require('./utils');
const {
	search_anilist,
	get_anilist_media_by_id,
	get_anilist_media_by_mal_id,
	proposal_from_anilist_media,
	get_anilist_url_and_thumbnail_url_by_anilist_id,
	proposal_from_url,
} = require('./anilist');

const Discord = require('discord.js');
const {
	mongoose,
	Server,
	get_user_proposal,
	get_user_watched_proposals,
	get_server_unwatched_proposals,
	get_proposal_from_anilist_id,
	get_most_recent_watched_proposal,
	get_server_without_anime_queue,
	remove_proposal,
	add_proposal,
	save_proposal,
} = require('./db.js');

const DEFAULT_PREFIX = '|';
const DEFAULT_BASE_ROLL_WEIGHT = 1;

async function ensure_guild_initialization(guild) {
	const server = await get_server_without_anime_queue(guild.id);
	if (server == null) {
		await Server.create({
			server_id: guild.id,
			config: {
				prefix: DEFAULT_PREFIX,
				base_roll_weight: DEFAULT_BASE_ROLL_WEIGHT,
				mod_role_ids: [],
				voice_channel_ids: [],
			},
			anime_queue: [],
		});
	} else {
		if (server.config.base_roll_weight == null)
			server.config.base_roll_weight = DEFAULT_BASE_ROLL_WEIGHT;
		if (server.config.voice_channel_ids == null)
			server.config.voice_channel_ids = [];
		if (server.config.mod_role_ids == null) server.config.mod_role_ids = [];
		if (server.config.prefix == null) server.config.prefix = DEFAULT_PREFIX;
		server.save();
	}
}
async function get_proposals_to_roll_from(server, msg) {
	let channels = await Promise.all(
		server.config.voice_channel_ids.map((voice_channel_id) =>
			msg.guild.channels.resolve(voice_channel_id)
		)
	);

	const user_proposal_promises = channels
		.map((vc) =>
			vc.members.map((member) => get_user_proposal(server, member.user.id))
		)
		.flat();

	const user_proposals = (await Promise.all(user_proposal_promises)).filter(
		(x) => x != null
	);

	return user_proposals;
}

function member_display_name(member) {
	return member.nickname || member.user.username;
}

function get_voice_channel_from_name(msg, voice_channel_name) {
	const channels = msg.guild.channels.cache.array();
	const matched_voice_channels = channels.filter(
		(channel) =>
			channel.type === 'voice' &&
			compare_no_case(channel.name, voice_channel_name)
	);
	if (matched_voice_channels.length == 0) {
		msg.channel.send(`No se encontro el canal de voz '${voice_channel_name}'`);
		return null;
	} else if (matched_voice_channels.length > 1) {
		msg.channel.send(
			`Se encontraron multiples canales de voz para la busqueda '${voice_channel_name}'`
		);
		return null;
	}
	return matched_voice_channels[0];
}

async function get_role_from_name(msg, role_name) {
	const roles = (await msg.guild.roles.fetch()).cache.array();
	const matched_roles = roles.filter((role) =>
		compare_no_case(role.name, role_name)
	);
	if (matched_roles.length == 0) {
		msg.channel.send(`No se encontro el rol '${role_name}'`);
		return null;
	} else if (matched_roles.length > 1) {
		msg.channel.send(
			`Se encontraron multiples roles para la busqueda '${role_name}'`
		);
		return null;
	}
	return matched_roles[0];
}

function is_admin(member) {
	return member.hasPermission('ADMINISTRATOR');
}

async function is_mod(member, server) {
	return (
		is_admin(member) ||
		(await member.roles.fetch()).cache.find((role) =>
			server.config.mod_role_ids.includes(role.id)
		)
	);
}

function admincommand_wrapper(fn) {
	return async function (server, msg, args) {
		if (await is_admin(msg.member)) {
			fn(server, msg, args);
		} else {
			msg.reply('No sos un admin!');
		}
	};
}

function modcommand_wrapper(fn) {
	return async function (server, msg, args) {
		if (await is_mod(msg.member, server)) {
			fn(server, msg, args);
		} else {
			msg.reply('No sos un mod!');
		}
	};
}

async function validate_conflicting_anime_entry(msg, server, anilist_id) {
	const conflicting_anime_entry = await get_proposal_from_anilist_id(
		server,
		anilist_id
	);

	if (conflicting_anime_entry != null) {
		const member_who_already_proposed = await msg.guild.members.fetch(
			conflicting_anime_entry.user_id
		);
		if (member_who_already_proposed == null) {
			//TODO: What do if member left server?
			msg.channel.send(
				`${conflicting_anime_entry.title} ya fue propuesto por alguien que dejo el server (TODO)`
			);
			return true;
		}
		msg.channel.send(
			`${
				conflicting_anime_entry.title
			} ya fue propuesto por ${member_display_name(
				member_who_already_proposed
			)}`
		);
		return true;
	}
	return false;
}
const client = new Discord.Client();

const commands = {
	addvoicechannel: modcommand_wrapper(async function (server, msg, args) {
		const voice_channel_name = msg.content.substr(msg.content.indexOf(' ') + 1);
		if (voice_channel_name == null || voice_channel_name.length == 0) {
			msg.channel.send(`Falta el nombre del canal de voz`);
			return;
		}

		const voice_channel = get_voice_channel_from_name(msg, voice_channel_name);
		if (voice_channel == null) return;

		const server_voice_channel_ids = server.config.voice_channel_ids;
		if (server_voice_channel_ids.includes(voice_channel.id)) {
			msg.channel.send(
				`'${voice_channel_name}' ya esta configurado como un canal de voz para la meetup!`
			);
			return;
		}

		server_voice_channel_ids.push(voice_channel.id);
		server.save();
		msg.channel.send(
			`Se agrego '${voice_channel.name}' como canal de voz para la meetup`
		);
	}),
	removevoicechannel: modcommand_wrapper(async function (server, msg, args) {
		const voice_channel_name = msg.content.substr(msg.content.indexOf(' ') + 1);
		if (voice_channel_name == null || voice_channel_name.length == 0) {
			msg.channel.send(`Falta el nombre del canal de voz`);
			return;
		}

		const voice_channel = get_voice_channel_from_name(msg, voice_channel_name);
		if (voice_channel == null) return;

		const server_voice_channel_ids = server.config.voice_channel_ids;
		if (!server_voice_channel_ids.includes(voice_channel.id)) {
			msg.channel.send(
				`'${voice_channel_name}' no esta configurdado como canal de voz de la meetup!`
			);
			return;
		}

		server_voice_channel_ids.splice(
			server_voice_channel_ids.indexOf(voice_channel.id),
			1
		);
		server.save();
		msg.channel.send(
			`'${voice_channel.name}' ya no es un canal de voz para la meetup`
		);
	}),
	votacion: modcommand_wrapper(async function (server, msg, args) {
		const last_watched_proposal = await get_most_recent_watched_proposal(
			server
		);

		if (last_watched_proposal == null) {
			msg.channel.send(`No hay ninguna propuesta vista!`);
			return;
		}

		if (last_watched_proposal.votes.length != 0) {
			msg.channel.send(
				`La ultima propuesta vista '${last_watched_proposal.title}' ya tiene votos!`
			);
			return;
		}

		const duration = 10 * 60 * 1000; // 10 minutes //TODO: Make this configurable?
		const deadline = Date.now() + duration;

		const msg_text_builder = () => {
			let votes = Array(10).fill(0);
			for (const vote of last_watched_proposal.votes) {
				console.log(vote.score);
				votes[vote.score - 1]++;
			}
			return votes
				.map(
					(vote, idx) =>
						`${char_to_emoji[idx + 1]} ${idx + 1}: **${vote} votos**`
				)
				.join('\n');
		};
		const embed_urls = await get_anilist_url_and_thumbnail_url_by_anilist_id(
			last_watched_proposal.anilist_id
		);
		let embed = () => ({
			embed: {
				title: last_watched_proposal.title,
				url: embed_urls.anilist_url,
				description: msg_text_builder(),
				fields: [{ name: 'Deadline', value: pretty_date(deadline) }],
				thumbnail: {
					url: embed_urls.thumbnail_url,
				},
			},
		});

		const channel = msg.channel;
		// See https://discordjs.guide/popular-topics/embeds.html#resending-a-received-embed
		// We deliberately send a copy
		const vote_msg = await channel.send(embed());

		const filter = (reaction, user) => {
			if (user.id == client.user.id) return false;
			const char = emoji_to_char[reaction.emoji.name];
			return char != null && !isNaN(char);
		};

		const collector = vote_msg.createReactionCollector(filter, {
			time: duration,
		});
		collector.on('collect', (reaction, user) => {
			const score = parseInt(emoji_to_char[reaction.emoji.name], 10);

			const existing_vote = last_watched_proposal.votes.find(
				(vote) => vote.user_id == user.id
			);
			if (existing_vote != null) {
				existing_vote.score = score;
			} else {
				last_watched_proposal.votes.push({
					user_id: user.id,
					score,
				});
			}

			// See https://discordjs.guide/popular-topics/embeds.html#resending-a-received-embed
			// We deliberately send a copy
			vote_msg.edit(embed());
		});
		collector.on('end', (collected) => {
			save_proposal(server, last_watched_proposal);
		});
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((x) =>
			vote_msg.react(char_to_emoji[x])
		);
	}),
	help: modcommand_wrapper(async function (server, msg, args) {
		msg.channel.send({
			embed: {
				title: 'Comandos de Tarobot',
				fields: [
					{
						name: 'Comandos de usuario',
						value: [
							'`help`: Este comando',
							'`proponer {url mal/anilist}`: proponer un anime',
							'`proponer -f {url mal/anilist}`: Sobreescribir propuesta actual (Resetea los tickets)',
							'`mipropuesta`: Te dice tu propuesta actual',
							'`propuestade {nombre usuario}`: Te dice la propuesta del usuario dado (TODO)',
							'`propuestas`: Te manda un DM con las propuestas actuales',
							'`modhelp`: Comandos de mod',
							'`adminhelp`: Comandos de admin',
						].concat(),
					},
				],
			},
		});
	}),
	modhelp: modcommand_wrapper(async function (server, msg, args) {
		msg.channel.send({
			embed: {
				title: 'Comandos de Tarobot',
				fields: [
					{
						name: 'Comandos de mod',
						value: [
							'`addvoicechannel {nombre canal de voz}`: Configura ese canal de voz como un canal de la meetup',
							'`removevoicechannel {nombre canal de voz}`: Desconfigura un canal de voz como canal de la meetup',
							'`votacion`: Inicia la votacion del ultimo anime rolleado',
							'`removeruserproposal {nombre de usuario}`: Quita la propuesta actual del usuario dado (TODO)',
							'`removeproposal {link de mal o anilist}`: Quita la propuesta dada',
							'`listvoicechannels`: Lista los canales de voz configurados',
							'`rollbaseweight`: Te responde con el peso base de las propuestas sin antiguedad (Cantida de tickets base)',
							'`rollbaseweight {numero}`: Cambia el peso base de las propuestas',
							'`prefijo {caracter}`: Cambia el prefijo del bot',
							'`roll`: Rollea entre las propuestas activas (Si tienen) de todos los usuarios en los canales de voz configurados',
						].concat(),
					},
				],
			},
		});
		msg.author.send();
	}),
	adminhelp: modcommand_wrapper(async function (server, msg, args) {
		msg.channel.send({
			embed: {
				title: 'Comandos de Tarobot',
				fields: [
					{
						name: 'Comandos de admin',
						value: [
							'`agregarrolmod {nombre de rol}`: Configura un rol como rol de mod del Tarobot',
							'`quitarrolmod {nombre de rol}`: Desconfigura un rol como rol de mod del Tarobot',
							'`rolesmod`: Lista los roles de mod configurados',
						].concat(),
					},
				],
			},
		});
	}),
	removeuserproposal: modcommand_wrapper(async function (server, msg, args) {
		const user_name = args[0];
		if (user_name == null || user_name.length == 0) {
			msg.reply(`Falta el primer parametro: nombre de usuario`);
			return;
		}

		msg.reply(`TODO: Encontrar el usuario por nombre`);
		// dummy condition to avoid eslint warn
		if (msg != null) {
			return;
		}

		const user_id = null; //TODO: Get user by name?
		if (user_id == null) {
			msg.reply(`No se encontro al usuario: ${user_name}`);
			return;
		}

		const proposal = await get_user_proposal(server, user_id);
		if (proposal == null) {
			msg.reply(`El usuario no tiene una propuesta activa`);
			return;
		}

		await remove_proposal(server, proposal);

		msg.reply(
			`Se borro la propuesta ${
				proposal.title
			} del usuario ${member_display_name(
				await msg.guild.members.fetch(proposal.user_id)
			)} propuesta el ${pretty_date(proposal.date_proposed)}`
		);
	}),
	removeproposal: modcommand_wrapper(async function (server, msg, args) {
		const url = args[0];
		if (url == null || url.length == 0) {
			msg.channel.send(
				`Falta el primer parametro: url de anilist o myanimelist`
			);
			return;
		}
		const proposal = await proposal_from_url(url, msg);
		if (proposal == null) {
			msg.reply(`URL de anilist o myanimelist invalida: ${url}`);
			return;
		}
		if (proposal.watched) {
			msg.reply(
				`El anime ${proposal.title} ya se vio. Si deseas borrarlo usa ${server.config.prefix}removewatched ${url}`
			);
			return;
		}

		await remove_proposal(server, proposal);

		msg.reply(
			`Se borro la propuesta ${
				proposal.title
			} del usuario ${member_display_name(
				await msg.guild.members.fetch(proposal.user_id)
			)} propuesta el ${proposal.date_proposed}`
		);
	}),
	listvoicechannels: modcommand_wrapper(async function (server, msg, args) {
		let channels = server.config.voice_channel_ids.map(
			(voice_channel_id) => msg.guild.channels.resolve(voice_channel_id).name
		);
		let response_msg =
			'Canales de voz configurados para la meetup: \n' + channels.join('\n');
		msg.channel.send(response_msg);
	}),
	rollbaseweight: modcommand_wrapper(async function (server, msg, args) {
		const new_base_weight_str = args[0];
		if (new_base_weight_str == null || new_base_weight_str.length == 0) {
			msg.channel.send(
				`Peso base de propuesta configurado en ${server.config.base_roll_weight}`
			);
			return;
		}

		const new_base_roll_weight = parseInt(new_base_weight_str, 10);
		if (isNaN(new_base_roll_weight)) {
			msg.channel.send(
				`${new_base_weight_str} no es un numero valido! No se ha cambiado el peso base de propuesta (${server.config.base_roll_weight})`
			);
			return;
		}

		server.config.base_roll_weight = new_base_roll_weight;
		msg.channel.send(
			`Peso base de propuesta del server cambiado por ${new_base_roll_weight}`
		);
		server.save();
	}),
	agregarrolmod: admincommand_wrapper(async function (server, msg, args) {
		const role_name = msg.content.substr(msg.content.indexOf(' ') + 1);
		if (role_name == null || role_name.length == 0) {
			msg.channel.send(`Falta el nombre del rol`);
			return;
		}

		const role = await get_role_from_name(msg, role_name);
		if (role == null) return;

		const server_mod_role_ids = server.config.mod_role_ids;
		if (server_mod_role_ids.includes(role.id)) {
			msg.channel.send(`'${role_name}' ya es un rol de mod!`);
			return;
		}
		server_mod_role_ids.push(role.id);
		server.save();
		msg.channel.send(`Configurado '${role.name}' como rol de mod`);
	}),
	quitarrolmod: admincommand_wrapper(async function (server, msg, args) {
		const role_name = msg.content.substr(msg.content.indexOf(' ') + 1);
		if (role_name == null || role_name.length == 0) {
			msg.channel.send(`Falta el nombre del rol`);
			return;
		}

		const role = await get_role_from_name(msg, role_name);
		if (role == null) return;

		const server_mod_role_ids = server.config.mod_role_ids;
		if (!server_mod_role_ids.includes(role.id)) {
			msg.channel.send(`'${role_name}' no es un rol de mod!`);
			return;
		}
		server_mod_role_ids.splice(server_mod_role_ids.indexOf(role.id), 1);
		server.save();
		msg.channel.send(`'${role.name}' ya no es un rol de mod`);
	}),
	rolesmod: admincommand_wrapper(async function (server, msg, args) {
		let roles = await Promise.all(
			server.config.mod_role_ids.map((role_id) =>
				msg.guild.roles.fetch(role_id).then((role) => role.name)
			)
		);
		let response_msg = 'Roles de mod: \n' + roles.join('\n');
		msg.channel.send(response_msg);
	}),
	prefijo: modcommand_wrapper(async function (server, msg, args) {
		const new_prefix = args[0];
		if (new_prefix != null && new_prefix.length == 1) {
			server.config.prefix = new_prefix;
			msg.channel.send(`Prefijo configurado como ${new_prefix}`);
			server.save();
		} else {
			msg.channel.send(
				`${new_prefix} no es un prefijo valido! Debe ser un solo caracter`
			);
		}
	}),
	propuestas: async function (server, msg, args) {
		const proposals = await get_server_unwatched_proposals(server);
		if (proposals.length == 0) {
			msg.author.send('No hay propuestas');
		} else {
			//TODO: Embed?
			msg.author.send(
				'Propuestas:\n' +
					(
						await Promise.all(
							proposals.map(
								async (p) =>
									`${p.title} propuesto por ${member_display_name(
										await msg.guild.members.fetch(p.user_id)
									)} el ${pretty_date(p.date_proposed)}`
							)
						)
					).join('\n')
			);
		}
	},
	roll: modcommand_wrapper(async function (server, msg, args) {
		//const proposals = await get_server_unwatched_proposals(server);
		const proposals = await get_proposals_to_roll_from(server, msg);

		if (proposals.length == 0) {
			msg.channel.send('No hay propuestas entre las que rollear!');
			return;
		}

		let weights = proposals.map((proposal) =>
			Math.min(
				server.config.base_roll_weight +
					Math.floor(days_since_date(proposal.date_proposed) / 7),
				5 //TODO: Configurable
			)
		);

		const rolled_proposal = weighted_roll(proposals, weights);

		const rolled_member = await msg.guild.members.fetch(
			rolled_proposal.user_id
		);
		if (rolled_member == null) {
			msg.channel.send(
				`Se rolleo '${rolled_proposal.title}' que fue propuesto por alguien que dejo el server (TODO: Handle this (Remove the proposal?))`
			);
			return;
		}

		const user_is_present = server.config.voice_channel_ids.find(
			(voice_channel_id) =>
				msg.guild.channels
					.resolve(voice_channel_id)
					.members.some((member) => member.user.id == rolled_proposal.user_id)
		);

		if (!user_is_present) {
			msg.channel.send(
				`Rolleado '${
					rolled_proposal.title
				}' propuesto por ${member_display_name(
					rolled_member
				)} quien no esta presente`
			);

			rolled_member.send(
				`Tu propuesta '${rolled_proposal.title}' fue rolleada, pero como no estabas presente no se vio.\n`
			);
			//TODO: Reroll
			return;
		}

		msg.channel.send(
			`Rolleado '${rolled_proposal.title}' propuesto por ${member_display_name(
				rolled_member
			)}`
		);
		rolled_proposal.watched = true;
		rolled_proposal.date_watched = Date.now();
		save_proposal(server, rolled_proposal);
	}),
	propuestade: async function (server, msg, args) {
		const user_name = args[0];
		if (user_name == null || user_name.length == 0) {
			msg.reply(`Falta el primer parametro: nombre de usuario`);
			return;
		}

		msg.reply(`TODO: Encontrar el usuario por nombre`);
		// dummy condition to avoid eslint warn
		if (msg != null) {
			return;
		}

		const user_id = null; //TODO: Get user by name?
		if (user_id == null) {
			msg.reply(`No se encontro al usuario: ${user_name}`);
			return;
		}

		const proposal = await get_user_proposal(server, user_id);
		if (proposal == null) {
			msg.reply(`El usuario no tiene una propuesta activa`);
			return;
		}

		msg.channel.send(
			`La propuesta activa de ${user_name} es ${
				proposal.title
			} (Propuesta el ${pretty_date(proposal.date_proposed)})`
		);
	},
	mipropuesta: async function (server, msg, args) {
		const existing_proposal = await get_user_proposal(server, msg.author.id);
		if (existing_proposal != null) {
			msg.channel.send(
				`Tu propuesta activa es ${existing_proposal.title} (${pretty_date(
					existing_proposal.date_proposed
				)})`
			);
		} else {
			msg.reply(`No tienes una propuesta activa!`);
		}
	},
	proponer: async function (server, msg, args) {
		let title;
		let force;
		if (args[0] == '-f') {
			force = true;
			title = msg.content
				.substr(msg.content.indexOf(' ') + 1)
				.substr(msg.content.indexOf(' ') + 1);
		} else {
			force = false;
			title = msg.content.substr(msg.content.indexOf(' ') + 1);
		}

		if (title == null || title.length == 0) {
			msg.channel.send(`Falta el titulo del anime`);
			return;
		}

		const existing_proposal = await get_user_proposal(server, msg.author.id);
		if (existing_proposal) {
			if (!force) {
				msg.reply(
					`Ya propusiste ${existing_proposal.title}\nUsa '${server.config.prefix}proponer -f ${title}' para sobreescribarla`
				);
				return;
			} else {
				remove_proposal(server, existing_proposal);
			}
		}

		const proposal = await proposal_from_url(title, msg);
		if (proposal != null) {
			if (
				await validate_conflicting_anime_entry(msg, server, proposal.anilist_id)
			) {
				return;
			}
			add_proposal(server, proposal);

			msg.channel.send(`Tu propuesta ahora es ${proposal.title}`);
			return;
		}

		// dummy condition to avoid eslint warn
		if (msg != null) {
			msg.channel.send(
				`Todavia no se soporta seleccion de una busqueda en anilist por emoji`
			);
			return;
		}

		const res_page = await search_anilist(title, 1, 10);
		// TODO: Make this message pretty and react with number emojis
		// TODO: Pagination (React with prev/next emojis, allow them in the collector,
		//       and handle them to query the next/prev page from anilist and edit the message)
		const list_msg = await msg.channel.send(
			new Discord.MessageEmbed()
				.setTitle(`Resultados para '${title}'`)
				.addFields(
					res_page.media.map((media) => {
						return {
							name: media.title.english || media.title.romaji,
							value: 'x',
						};
					})
				)
		);

		const filter = (reaction, user) => {
			const char = emoji_to_char[reaction.emoji.name];
			//TODO: Allow prev/next emojis
			return user.id == msg.author.id && char != null && Number.isInteger(char);
		};

		list_msg
			.awaitReactions(filter, { max: 1, time: 15000, errors: ['time'] })
			.then((collected) => {
				//TODO: Get the corresponding anilist media from the search response
				//      and make the proposal from that
				//TODO: Will probably also have to check for next/prev page emoji reactions here
				const proposal = {
					votes: [],
					user_id: msg.author.id,
					date_proposed: Date.now(),
					date_watched: null,
					watched: false,
					title: title,
					anilist_id: null,
					mal_id: null,
				};
				add_proposal(server, proposal);

				msg.channel.send(`Tu propuesta ahora es ${title}`);
			})
			.catch((collected) => {
				msg.reply(`Se agoto el tiempo de espera!`);
			});
	},
};

async function run() {
	try {
		await mongoose
			.connect(process.env.M_URI, { useUnifiedTopology: true })
			.catch((error) => {
				console.log(`Error connecting to mongodb: ${error}`);
				process.exit();
			});
		console.log('Succesfully connected to mongo database!');

		client.on('ready', async () => {
			console.log(`Logged in as ${client.user.tag}!`);

			await Promise.all(client.guilds.cache.map(ensure_guild_initialization));
		});
		client.on('guildCreate', async (guild) => {
			await ensure_guild_initialization(guild);
		});

		client.on('message', async (msg) => {
			if (msg.guild == null) return; // Ignorar DMs

			const server = await get_server_without_anime_queue(msg.guild.id);
			const prefix = server.config.prefix;
			if (!msg.content.startsWith(prefix) || msg.author.bot) return;

			const args = msg.content.slice(prefix.length).trim().split(/ +/);
			const command = args.shift().toLowerCase(); // lowercase and shift() to remove prefix

			const command_fn = commands[command];
			if (command_fn != null) {
				command_fn(server, msg, args);
			}
		});

		await client.login(process.env.D_TOKEN);
		console.log('Succesfully initialized discord bot!');
	} catch (error) {
		console.log(`Error: ${error}`);
		process.exit();
		throw error;
	}
}
run().catch(console.dir);
