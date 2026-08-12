const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors());

// 🔥 Frontend servido desde EC2
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════ BASE DE DATOS ═══════════════
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'fakebook-db.cvsyk08ku3zp.us-east-2.rds.amazonaws.com',
    user: process.env.DB_USER || 'admin',
    password: process.env.DB_PASSWORD || 'Melvinbasededatos',
    database: process.env.DB_NAME || 'fakebook_db',
    waitForConnections: true,
    connectionLimit: 10
});

pool.getConnection()
    .then(conn => { console.log('✅ Conectado a RDS'); conn.release(); })
    .catch(err => console.error('❌ Error BD:', err));

const JWT_SECRET = process.env.JWT_SECRET || 'fakebook_secret_2024_super_segura';

// ═══════════════ MIDDLEWARES ═══════════════
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido' });
        req.user = user;
        next();
    });
}

function isAdmin(req, res, next) {
    if (!req.user.isAdmin) {
        return res.status(403).json({ error: 'Acceso denegado. Se requieren permisos de administrador.' });
    }
    next();
}

// ═══════════════ RUTA PRINCIPAL ═══════════════
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════ REGISTRO ═══════════════
app.post('/api/register', async (req, res) => {
    try {
        const { full_name, username, password, avatar_color } = req.body;
        if (!full_name || !username || !password) {
            return res.status(400).json({ error: 'Todos los campos son obligatorios' });
        }

        const [existingUser] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
        const [existingAdmin] = await pool.query('SELECT id FROM admins WHERE username = ?', [username]);
        
        if (existingUser.length > 0 || existingAdmin.length > 0) {
            return res.status(400).json({ error: 'El nombre de usuario ya existe' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const [result] = await pool.query(
            'INSERT INTO users (full_name, username, password, avatar_color) VALUES (?, ?, ?, ?)',
            [full_name, username, hashedPassword, avatar_color || '#1877F2']
        );

        const token = jwt.sign(
            { id: result.insertId, username, full_name, isAdmin: false, type: 'user' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(201).json({
            token,
            user: {
                id: result.insertId, full_name, username,
                avatar_color: avatar_color || '#1877F2',
                profile_pic: null, isAdmin: false
            }
        });
    } catch (error) {
        console.error('Error registro:', error);
        res.status(500).json({ error: 'Error al registrar' });
    }
});

// ═══════════════ LOGIN ═══════════════
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
        }

        const [admins] = await pool.query('SELECT * FROM admins WHERE username = ?', [username]);
        
        if (admins.length > 0) {
            const admin = admins[0];
            const validPassword = await bcrypt.compare(password, admin.password);
            if (!validPassword) {
                return res.status(401).json({ error: 'Credenciales incorrectas' });
            }

            const token = jwt.sign(
                { id: admin.id, username: admin.username, full_name: admin.full_name, isAdmin: true, type: 'admin' },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            return res.json({
                token,
                user: {
                    id: admin.id, full_name: admin.full_name, username: admin.username,
                    avatar_color: admin.avatar_color, profile_pic: admin.profile_pic, isAdmin: true
                }
            });
        }

        const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        
        if (users.length === 0) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        await pool.query('UPDATE users SET online = TRUE WHERE id = ?', [user.id]);

        const token = jwt.sign(
            { id: user.id, username: user.username, full_name: user.full_name, isAdmin: false, type: 'user' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user.id, full_name: user.full_name, username: user.username,
                avatar_color: user.avatar_color, profile_pic: user.profile_pic, isAdmin: false
            }
        });
    } catch (error) {
        console.error('Error login:', error);
        res.status(500).json({ error: 'Error al iniciar sesión' });
    }
});

// ═══════════════ POSTS ═══════════════
app.get('/api/posts', async (req, res) => {
    try {
        const { search } = req.query;
        let query = `
            SELECT p.*, 
                   COALESCE(u.full_name, a.full_name) AS author_name,
                   COALESCE(u.avatar_color, a.avatar_color) AS author_color,
                   COALESCE(u.profile_pic, a.profile_pic) AS author_profile_pic,
                   CASE WHEN a.id IS NOT NULL THEN TRUE ELSE FALSE END AS author_isAdmin
            FROM posts p
            LEFT JOIN users u ON p.author_id = u.id AND p.author_type = 'user'
            LEFT JOIN admins a ON p.author_id = a.id AND p.author_type = 'admin'
        `;
        let params = [];

        if (search && search.trim()) {
            query += ' WHERE p.content LIKE ? OR u.full_name LIKE ? OR a.full_name LIKE ?';
            params = [`%${search.trim()}%`, `%${search.trim()}%`, `%${search.trim()}%`];
        }

        query += ' ORDER BY p.created_at DESC';
        const [posts] = await pool.query(query, params);

        const enrichedPosts = await Promise.all(posts.map(async (post) => {
            const [likes] = await pool.query('SELECT user_id FROM post_likes WHERE post_id = ?', [post.id]);
            const [comments] = await pool.query(
                `SELECT c.*, COALESCE(u.full_name, a.full_name) AS author_name,
                        COALESCE(u.avatar_color, a.avatar_color) AS author_color
                 FROM post_comments c
                 LEFT JOIN users u ON c.author_id = u.id AND c.author_type = 'user'
                 LEFT JOIN admins a ON c.author_id = a.id AND c.author_type = 'admin'
                 WHERE c.post_id = ? ORDER BY c.created_at ASC`,
                [post.id]
            );
            return { ...post, likes, comments };
        }));

        res.json(enrichedPosts);
    } catch (error) {
        console.error('Error posts:', error);
        res.status(500).json({ error: 'Error al obtener publicaciones' });
    }
});

app.post('/api/posts', authenticateToken, async (req, res) => {
    try {
        const { content, image } = req.body;
        if (!content && !image) return res.status(400).json({ error: 'Publicación vacía' });

        const [result] = await pool.query(
            'INSERT INTO posts (author_id, author_type, content, image) VALUES (?, ?, ?, ?)',
            [req.user.id, req.user.type || 'user', content || '', image || null]
        );

        const authorTable = req.user.isAdmin ? 'admins' : 'users';
        const [author] = await pool.query(`SELECT full_name, avatar_color, profile_pic FROM ${authorTable} WHERE id = ?`, [req.user.id]);

        res.status(201).json({
            id: result.insertId,
            author_id: req.user.id,
            author_name: author[0].full_name,
            author_color: author[0].avatar_color,
            author_profile_pic: author[0].profile_pic,
            author_isAdmin: req.user.isAdmin,
            content: content || '',
            image: image || null,
            created_at: new Date().toISOString(),
            likes: [],
            comments: []
        });
    } catch (error) {
        console.error('Error crear post:', error);
        res.status(500).json({ error: 'Error al publicar' });
    }
});

app.post('/api/posts/:id/like', authenticateToken, async (req, res) => {
    try {
        const [existing] = await pool.query('SELECT id FROM post_likes WHERE post_id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (existing.length > 0) {
            await pool.query('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', [req.params.id, req.user.id]);
            res.json({ liked: false });
        } else {
            await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)', [req.params.id, req.user.id]);
            res.json({ liked: true });
        }
    } catch (error) {
        console.error('Error like:', error);
        res.status(500).json({ error: 'Error al procesar like' });
    }
});

app.post('/api/posts/:id/comments', authenticateToken, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text?.trim()) return res.status(400).json({ error: 'Comentario vacío' });

        const [result] = await pool.query(
            'INSERT INTO post_comments (post_id, author_id, author_type, text) VALUES (?, ?, ?, ?)',
            [req.params.id, req.user.id, req.user.type || 'user', text.trim()]
        );

        const authorTable = req.user.isAdmin ? 'admins' : 'users';
        const [author] = await pool.query(`SELECT full_name, avatar_color FROM ${authorTable} WHERE id = ?`, [req.user.id]);

        res.status(201).json({
            id: result.insertId,
            author_id: req.user.id,
            author_name: author[0].full_name,
            author_color: author[0].avatar_color,
            text: text.trim(),
            created_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error comentario:', error);
        res.status(500).json({ error: 'Error al comentar' });
    }
});

app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
    try {
        const [post] = await pool.query('SELECT author_id, author_type FROM posts WHERE id = ?', [req.params.id]);
        if (!post.length) return res.status(404).json({ error: 'No encontrada' });
        if (post[0].author_id !== req.user.id && !req.user.isAdmin) {
            return res.status(403).json({ error: 'No autorizado' });
        }
        await pool.query('DELETE FROM posts WHERE id = ?', [req.params.id]);
        res.json({ message: 'Eliminada' });
    } catch (error) {
        console.error('Error eliminar post:', error);
        res.status(500).json({ error: 'Error al eliminar' });
    }
});

// ═══════════════ COMPARTIR PUBLICACIONES ═══════════════
app.post('/api/posts/:id/share', authenticateToken, async (req, res) => {
    try {
        const postId = req.params.id;
        const userId = req.user.id;

        const [existing] = await pool.query('SELECT id FROM shared_posts WHERE post_id = ? AND user_id = ?', [postId, userId]);
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Ya compartiste esta publicación' });
        }

        await pool.query('INSERT INTO shared_posts (post_id, user_id) VALUES (?, ?)', [postId, userId]);
        res.json({ message: 'Publicación compartida exitosamente' });
    } catch (error) {
        console.error('Error compartir:', error);
        res.status(500).json({ error: 'Error al compartir publicación' });
    }
});

app.get('/api/users/:id/shares', authenticateToken, async (req, res) => {
    try {
        const userId = req.params.id;
        const query = `
            SELECT p.*, 
                   COALESCE(u.full_name, a.full_name) AS author_name,
                   COALESCE(u.avatar_color, a.avatar_color) AS author_color,
                   COALESCE(u.profile_pic, a.profile_pic) AS author_profile_pic,
                   CASE WHEN a.id IS NOT NULL THEN TRUE ELSE FALSE END AS author_isAdmin,
                   sp.created_at AS shared_at
            FROM shared_posts sp
            JOIN posts p ON sp.post_id = p.id
            LEFT JOIN users u ON p.author_id = u.id AND p.author_type = 'user'
            LEFT JOIN admins a ON p.author_id = a.id AND p.author_type = 'admin'
            WHERE sp.user_id = ?
            ORDER BY sp.created_at DESC
        `;
        const [shares] = await pool.query(query, [userId]);

        const enrichedShares = await Promise.all(shares.map(async (post) => {
            const [likes] = await pool.query('SELECT user_id FROM post_likes WHERE post_id = ?', [post.id]);
            const [comments] = await pool.query(
                `SELECT c.*, COALESCE(u.full_name, a.full_name) AS author_name,
                        COALESCE(u.avatar_color, a.avatar_color) AS author_color
                 FROM post_comments c
                 LEFT JOIN users u ON c.author_id = u.id AND c.author_type = 'user'
                 LEFT JOIN admins a ON c.author_id = a.id AND c.author_type = 'admin'
                 WHERE c.post_id = ? ORDER BY c.created_at ASC`,
                [post.id]
            );
            return { ...post, likes, comments };
        }));

        res.json(enrichedShares);
    } catch (error) {
        console.error('Error obtener compartidos:', error);
        res.status(500).json({ error: 'Error al obtener publicaciones compartidas' });
    }
});

// ═══════════════ FOTOS POR USUARIO ═══════════════
app.get('/api/users/:id/photos', authenticateToken, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        
        let profilePic = null;
        const [user] = await pool.query('SELECT profile_pic FROM users WHERE id = ?', [userId]);
        if (user.length > 0 && user[0].profile_pic) {
            profilePic = user[0].profile_pic;
        } else {
            const [admin] = await pool.query('SELECT profile_pic FROM admins WHERE id = ?', [userId]);
            if (admin.length > 0 && admin[0].profile_pic) {
                profilePic = admin[0].profile_pic;
            }
        }
        
        const [posts] = await pool.query(
            'SELECT id, image, created_at FROM posts WHERE author_id = ? AND image IS NOT NULL AND image != "" ORDER BY created_at DESC',
            [userId]
        );
        
        res.json({
            profile_pic: profilePic,
            posts: posts
        });
    } catch (error) {
        console.error('Error obtener fotos:', error);
        res.status(500).json({ error: 'Error al obtener fotos' });
    }
});

// ═══════════════ CHATS / MENSAJES ═══════════════
app.post('/api/messages', authenticateToken, async (req, res) => {
    try {
        const { receiver_id, message } = req.body;
        if (!receiver_id || !message?.trim()) {
            return res.status(400).json({ error: 'Faltan datos' });
        }
        
        const [result] = await pool.query(
            'INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)',
            [req.user.id, receiver_id, message.trim()]
        );
        
        res.status(201).json({
            id: result.insertId,
            sender_id: req.user.id,
            receiver_id,
            message: message.trim(),
            created_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error enviar mensaje:', error);
        res.status(500).json({ error: 'Error al enviar mensaje' });
    }
});

app.get('/api/messages/:userId', authenticateToken, async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const [messages] = await pool.query(
            `SELECT m.*, u.full_name AS sender_name, u.avatar_color AS sender_color
             FROM messages m
             JOIN users u ON m.sender_id = u.id
             WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
             ORDER BY m.created_at ASC`,
            [req.user.id, userId, userId, req.user.id]
        );
        res.json(messages);
    } catch (error) {
        console.error('Error obtener mensajes:', error);
        res.status(500).json({ error: 'Error al obtener mensajes' });
    }
});

// ═══════════════ USUARIOS ═══════════════
app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        const [users] = await pool.query(
            `SELECT u.id, u.full_name, u.username, u.avatar_color, u.profile_pic, u.online,
                    CASE 
                        WHEN f.status = 'accepted' THEN 'friends'
                        WHEN f.status = 'pending' AND f.user1_id = ? THEN 'sent'
                        WHEN f.status = 'pending' AND f.user2_id = ? THEN 'received'
                        ELSE 'none'
                    END AS friendship_status
             FROM users u
             LEFT JOIN friends f ON (f.user1_id = u.id AND f.user2_id = ?) OR (f.user2_id = u.id AND f.user1_id = ?)
             WHERE u.id != ?
             GROUP BY u.id`,
            [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]
        );
        res.json(users);
    } catch (error) {
        console.error('Error usuarios:', error);
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
    try {
        const { profile_pic } = req.body;
        const table = req.user.isAdmin ? 'admins' : 'users';
        if (profile_pic) {
            await pool.query(`UPDATE ${table} SET profile_pic = ? WHERE id = ?`, [profile_pic, req.user.id]);
        }
        res.json({ message: 'Perfil actualizado' });
    } catch (error) {
        console.error('Error perfil:', error);
        res.status(500).json({ error: 'Error al actualizar perfil' });
    }
});

// ═══════════════ AMIGOS ═══════════════
app.post('/api/friends/request', authenticateToken, async (req, res) => {
    try {
        const { user_id } = req.body;
        if (user_id == req.user.id) return res.status(400).json({ error: 'No puedes enviarte a ti mismo' });
        
        const [existing] = await pool.query(
            'SELECT * FROM friends WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)',
            [req.user.id, user_id, user_id, req.user.id]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Ya existe una solicitud o son amigos' });
        }

        await pool.query('INSERT INTO friends (user1_id, user2_id, status) VALUES (?, ?, ?)', [req.user.id, user_id, 'pending']);
        res.status(201).json({ message: 'Solicitud enviada' });
    } catch (error) {
        console.error('Error solicitud:', error);
        res.status(500).json({ error: 'Error al enviar solicitud' });
    }
});

app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    try {
        const { user_id } = req.body;
        const [result] = await pool.query(
            'UPDATE friends SET status = ? WHERE user1_id = ? AND user2_id = ? AND status = ?',
            ['accepted', user_id, req.user.id, 'pending']
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Solicitud no encontrada' });
        }
        res.json({ message: 'Solicitud aceptada' });
    } catch (error) {
        console.error('Error aceptar:', error);
        res.status(500).json({ error: 'Error al aceptar solicitud' });
    }
});

app.get('/api/friends/requests', authenticateToken, async (req, res) => {
    try {
        const [requests] = await pool.query(
            `SELECT f.id, f.user1_id, u.full_name, u.username, u.avatar_color, u.profile_pic
             FROM friends f JOIN users u ON f.user1_id = u.id
             WHERE f.user2_id = ? AND f.status = 'pending'`,
            [req.user.id]
        );
        res.json(requests);
    } catch (error) {
        console.error('Error solicitudes:', error);
        res.status(500).json({ error: 'Error al obtener solicitudes' });
    }
});

app.get('/api/friends', authenticateToken, async (req, res) => {
    try {
        const [friends] = await pool.query(
            `SELECT u.id, u.full_name, u.username, u.avatar_color, u.profile_pic, u.online
             FROM friends f
             JOIN users u ON (f.user1_id = u.id OR f.user2_id = u.id)
             WHERE (f.user1_id = ? OR f.user2_id = ?) AND f.status = 'accepted' AND u.id != ?`,
            [req.user.id, req.user.id, req.user.id]
        );
        res.json(friends);
    } catch (error) {
        console.error('Error amigos:', error);
        res.status(500).json({ error: 'Error al obtener amigos' });
    }
});

// ═══════════════ ADMIN PANEL ═══════════════
app.get('/api/admin/stats', authenticateToken, isAdmin, async (req, res) => {
    try {
        const [users] = await pool.query('SELECT COUNT(*) as count FROM users');
        const [posts] = await pool.query('SELECT COUNT(*) as count FROM posts');
        const [comments] = await pool.query('SELECT COUNT(*) as count FROM post_comments');
        const [admins] = await pool.query('SELECT COUNT(*) as count FROM admins');
        
        res.json({
            users: users[0].count,
            posts: posts[0].count,
            comments: comments[0].count,
            admins: admins[0].count
        });
    } catch (error) {
        console.error('Error stats:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});

app.get('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
    try {
        const [users] = await pool.query('SELECT id, full_name, username, avatar_color, profile_pic, online, created_at FROM users ORDER BY created_at DESC');
        res.json(users);
    } catch (error) {
        console.error('Error admin users:', error);
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});

app.delete('/api/admin/users/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        if (userId == req.user.id) {
            return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
        }
        
        const [result] = await pool.query('DELETE FROM users WHERE id = ?', [userId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        res.json({ message: 'Usuario eliminado exitosamente' });
    } catch (error) {
        console.error('Error eliminar usuario:', error);
        res.status(500).json({ error: 'Error al eliminar usuario' });
    }
});

app.delete('/api/admin/posts/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        const [result] = await pool.query('DELETE FROM posts WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Publicación no encontrada' });
        }
        res.json({ message: 'Publicación eliminada exitosamente' });
    } catch (error) {
        console.error('Error eliminar post:', error);
        res.status(500).json({ error: 'Error al eliminar publicación' });
    }
});

app.delete('/api/admin/comments/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        const [result] = await pool.query('DELETE FROM post_comments WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Comentario no encontrado' });
        }
        res.json({ message: 'Comentario eliminado exitosamente' });
    } catch (error) {
        console.error('Error eliminar comentario:', error);
        res.status(500).json({ error: 'Error al eliminar comentario' });
    }
});

// ═══════════════ INICIAR SERVIDOR ═══════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Servidor corriendo en puerto', PORT);
    console.log('🌐 Accede desde http://fakebook.sytes.net:' + PORT);
    console.log('👑 Admin: admin');
    console.log('');
});
